import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosGateway } from "../../src/gateway";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

/**
 * Coexistence `history` and `smb_app_state_sync` webhooks arrive once per
 * number and cannot be requested again, so they are stored raw (eccos-yqbz.1).
 */

afterEach(async () => {
  await reset();
});

function syncEnvelope(field: string, value: Record<string, unknown>, wabaId = TEST_WABA_ID) {
  return { object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field, value }] }] };
}

const METADATA = { display_phone_number: "34600000000", phone_number_id: "PNID1" };

const HISTORY = syncEnvelope("history", {
  messaging_product: "whatsapp",
  metadata: METADATA,
  history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [] }],
});

const HISTORY_MEDIA = syncEnvelope("history", {
  messaging_product: "whatsapp",
  metadata: METADATA,
  messages: [{ from: "34600000001", id: "wamid.H1", timestamp: "1700000000", type: "image", image: { id: "M1" } }],
});

const CONTACTS = syncEnvelope("smb_app_state_sync", {
  messaging_product: "whatsapp",
  metadata: METADATA,
  state_sync: [{ type: "contact", contact: { full_name: "Test Contact", phone_number: "34600000002" }, action: "add" }],
});

async function postWebhook(body: string): Promise<Response> {
  return exports.default.fetch("http://example.com/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
    body,
  });
}

function storedPayloads(instance: EccosGateway): Array<{ fields: string; body: string; parts: number }> {
  return instance.sql
    .exec("SELECT id, fields, part_count FROM sync_payloads ORDER BY id")
    .toArray()
    .map((row) => {
      const chunks = instance.sql
        .exec("SELECT chunk FROM sync_payload_parts WHERE payload_id = ? ORDER BY ordinal", row.id)
        .toArray()
        .map((part) => new Uint8Array(part.chunk as ArrayBuffer));
      const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      expect(chunks.length).toBe(row.part_count);
      return { fields: row.fields as string, body: new TextDecoder().decode(bytes), parts: chunks.length };
    });
}

describe("coexistence sync capture", () => {
  it.each([
    ["history", HISTORY],
    ["history media", HISTORY_MEDIA],
    ["smb_app_state_sync", CONTACTS],
  ])("stores a %s webhook once, even when Meta retries it", async (_, envelope) => {
    await bootstrapAccount();
    const body = JSON.stringify(envelope);
    expect((await postWebhook(body)).status).toBe(200);
    expect((await postWebhook(body)).status).toBe(200);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const stored = storedPayloads(instance);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.body).toBe(body);
      expect(stored[0]!.fields).toBe(envelope.entry[0]!.changes[0]!.field);
      // Captured, never parsed or forwarded.
      expect(instance.sql.exec("SELECT COUNT(*) AS c FROM inbound_events").one().c).toBe(0);
      expect(instance.sql.exec("SELECT COUNT(*) AS c FROM deliveries").one().c).toBe(0);
    });
  });

  it("stores one row per WABA for a body with several sync changes", async () => {
    await bootstrapAccount();
    const envelope = {
      object: "whatsapp_business_account",
      entry: [{ id: TEST_WABA_ID, changes: [...HISTORY.entry[0]!.changes, ...CONTACTS.entry[0]!.changes] }],
    };
    const body = JSON.stringify(envelope);
    expect((await postWebhook(body)).status).toBe(200);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const stored = storedPayloads(instance);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.fields).toBe("history,smb_app_state_sync");
    });
  });

  it("splits a payload over 2 MB into parts that reassemble byte-identical", async () => {
    await bootstrapAccount();
    const text = "hola ñandú 👋 ".repeat(200_000);
    const body = JSON.stringify(
      syncEnvelope("history", {
        messaging_product: "whatsapp",
        metadata: METADATA,
        history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: "34600000001", messages: [{ text }] }] }],
      }),
    );
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(2 * 1024 * 1024);
    expect((await postWebhook(body)).status).toBe(200);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      const [stored] = storedPayloads(instance);
      expect(stored!.parts).toBeGreaterThan(1);
      expect(stored!.body).toBe(body);
    });
  });

  it("keeps captured payloads through the retention sweep", async () => {
    await bootstrapAccount();
    expect((await postWebhook(JSON.stringify(HISTORY))).status).toBe(200);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      instance.pruneExpired(Date.now() + 1000 * 24 * 60 * 60 * 1000, 7, 7);
      expect(storedPayloads(instance)).toHaveLength(1);
    });
  });

  it("captures for a WABA still pending provisioning", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (cp) => {
      await cp.createAccount({ accountId: TEST_ACCOUNT_ID });
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: TEST_WABA_ID,
        metaAccessToken: "tenant-token",
        provisioningStatus: "pending",
        phones: [{ phoneNumberId: "PNID1" }],
      });
    });
    expect((await postWebhook(JSON.stringify(CONTACTS))).status).toBe(200);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      expect(storedPayloads(instance)).toHaveLength(1);
    });
  });

  it("ignores a sync webhook for a WABA the control plane does not know", async () => {
    await bootstrapAccount();
    const res = await postWebhook(JSON.stringify(syncEnvelope("history", { history: [] }, "WABA_UNKNOWN")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: 0 });
  });

  it("answers 5xx when the capture cannot be stored, so Meta retries", async () => {
    await bootstrapAccount();
    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      instance.sql.exec("DROP TABLE sync_payload_parts");
    });
    const res = await postWebhook(JSON.stringify(HISTORY));
    expect(res.status).toBe(503);

    await runInDurableObject(gatewayStub(), async (instance: EccosGateway) => {
      // The transaction rolled back: no header row without its parts.
      expect(instance.sql.exec("SELECT COUNT(*) AS c FROM sync_payloads").one().c).toBe(0);
    });
  });
});
