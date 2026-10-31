import { env, exports } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signPayload } from "@eccos/core/signature";
import type { EccosControlPlane } from "../../src/control-plane";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { type EccosGateway, SYNC_MAX_ATTEMPTS, SYNC_MAX_BYTES } from "../../src/gateway";
import { getGatewayStubForWaba } from "../../src/gateway-stub";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

/**
 * Processing of the raw coexistence sync payloads into `messages` and `contacts`.
 * Fixtures follow Meta's documented shapes for the onboarding business-app flow;
 * every number and id here is made up.
 */

const BUSINESS = "34600000000";
const CUSTOMER = "34600000001";
const OTHER = "34600000002";
const METADATA = { display_phone_number: BUSINESS, phone_number_id: "PNID1" };

beforeEach(async () => {
  await bootstrapAccount();
});

afterEach(async () => {
  await reset();
});

function envelope(field: string, value: Record<string, unknown>, wabaId = TEST_WABA_ID) {
  return { object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field, value }] }] };
}

function historyChunk(threads: unknown[], chunkOrder = 0) {
  return envelope("history", {
    messaging_product: "whatsapp",
    metadata: METADATA,
    history: [{ metadata: { phase: 0, chunk_order: chunkOrder, progress: 100 }, threads }],
  });
}

function thread(id: string, messages: unknown[]) {
  return { id, messages };
}

function textMessage(from: string, id: string, timestamp: string, body: string, status = "DELIVERED") {
  return { from, id, timestamp, type: "text", text: { body }, history_context: { status } };
}

function placeholder(from: string, id: string, timestamp: string) {
  return { from, id, timestamp, type: "media_placeholder", history_context: { status: "DELIVERED" } };
}

function mediaWebhook(from: string, id: string, timestamp: string, caption: string) {
  return envelope("history", {
    messaging_product: "whatsapp",
    metadata: METADATA,
    messages: [{ from, id, timestamp, type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", sha256: "c2hhLWZpeHR1cmU=", caption } }],
  });
}

function appState(action: "add" | "remove", phone: string, fullName?: string) {
  return envelope("smb_app_state_sync", {
    messaging_product: "whatsapp",
    metadata: METADATA,
    state_sync: [
      {
        type: "contact",
        contact: fullName ? { full_name: fullName, first_name: fullName.split(" ")[0], phone_number: phone } : { phone_number: phone },
        action,
        metadata: { timestamp: "1700000000" },
      },
    ],
  });
}

async function capture(body: unknown, fields: string): Promise<void> {
  const raw = JSON.stringify(body);
  await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.captureSyncPayload(fields.split(","), raw));
}

async function query(sql: string, ...args: unknown[]): Promise<Record<string, unknown>[]> {
  return runInDurableObject(gatewayStub(), (i: EccosGateway) => i.sql.exec(sql, ...args).toArray());
}

/** Runs alarms until every captured payload is processed; returns how many ran. The pause
 * keeps each wake a millisecond later than the alarm it answers: the alarm harness does
 * not fire an alarm scheduled for the same millisecond. */
async function drain(maxRuns = 20): Promise<number> {
  let runs = 0;
  while (runs < maxRuns && (await query(`SELECT 1 FROM sync_payloads WHERE processed_at IS NULL`)).length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runDurableObjectAlarm(gatewayStub());
    runs++;
  }
  return runs;
}

/** The workspace's retention window, as the control plane holds it (null keeps everything). */
async function setRetention(days: number | null): Promise<void> {
  await runInDurableObject(getControlPlaneStub(env), (cp: EccosControlPlane) =>
    cp.setConversationRetentionDays(TEST_ACCOUNT_ID, days),
  );
}

async function snapshot() {
  return {
    messages: await query(`SELECT id, wa_id, direction, origin, type, text, content, at, status FROM messages ORDER BY id`),
    contacts: await query(`SELECT wa_id, name, source FROM contacts ORDER BY wa_id`),
  };
}

async function ingestLive(event: Record<string, unknown>): Promise<void> {
  await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
    i.ingest([event as never]);
  });
}

describe("history payloads", () => {
  it("stores each thread message with its direction, original time and status", async () => {
    await capture(
      historyChunk([
        thread(CUSTOMER, [
          textMessage(CUSTOMER, "wamid.H1", "1700000000", "hola"),
          textMessage(BUSINESS, "wamid.H2", "1700000060", "hello", "READ"),
        ]),
      ]),
      "history",
    );
    expect(await drain()).toBe(1);

    const messages = await query(`SELECT id, wa_id, direction, origin, type, text, at, status FROM messages ORDER BY at`);
    expect(messages).toEqual([
      { id: "wamid.H1", wa_id: CUSTOMER, direction: "in", origin: "history", type: "text", text: "hola", at: 1700000000000, status: null },
      { id: "wamid.H2", wa_id: CUSTOMER, direction: "echo", origin: "history", type: "text", text: "hello", at: 1700000060000, status: "read" },
    ]);
    const contacts = await query(`SELECT wa_id, name, source FROM contacts`);
    expect(contacts).toEqual([{ wa_id: CUSTOMER, name: null, source: "history" }]);
  });

  it("completes a media placeholder from the media webhook, whichever arrives first", async () => {
    await capture(historyChunk([thread(CUSTOMER, [placeholder(CUSTOMER, "wamid.M1", "1700000000")])]), "history");
    await drain();
    expect((await query(`SELECT type, content FROM messages WHERE id = 'wamid.M1'`))[0]).toEqual({
      type: "media_placeholder",
      content: null,
    });

    await capture(mediaWebhook(CUSTOMER, "wamid.M1", "1700000000", "Photo"), "history");
    await drain();
    const [row] = await query(`SELECT type, text, content FROM messages WHERE id = 'wamid.M1'`);
    expect(row.type).toBe("image");
    expect(row.text).toBe("Photo");
    expect(JSON.parse(row.content as string)).toEqual({
      media: { id: "MEDIA1", mimeType: "image/jpeg", sha256: "c2hhLWZpeHR1cmU=", caption: "Photo" },
    });
  });

  it("keeps the media reference when the media webhook is processed before the placeholder", async () => {
    await capture(mediaWebhook(CUSTOMER, "wamid.M2", "1700000000", "Photo"), "history");
    await capture(historyChunk([thread(CUSTOMER, [placeholder(CUSTOMER, "wamid.M2", "1700000000")])]), "history");
    await drain();
    const [row] = await query(`SELECT type, content FROM messages WHERE id = 'wamid.M2'`);
    expect(row.type).toBe("image");
    expect(JSON.parse(row.content as string).media.id).toBe("MEDIA1");
  });

  it("records the 2593109 refusal on the payload and does not store messages", async () => {
    await capture(
      envelope("history", {
        messaging_product: "whatsapp",
        metadata: METADATA,
        history: [{ errors: [{ code: 2593109, title: "History sharing is off", message: "Sharing is off" }] }],
      }),
      "history",
    );
    await drain();
    const [payload] = await query(`SELECT error, processed_at FROM sync_payloads`);
    expect(payload.error).toBe("Meta error 2593109");
    expect(payload.processed_at).not.toBeNull();
    expect(await query(`SELECT id FROM messages`)).toEqual([]);
  });

  it("never overwrites a live message with the same id", async () => {
    await ingestLive({ type: "reply", from: CUSTOMER, messageId: "wamid.L1", text: "live text", at: 1700000500000 });
    await capture(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.L1", "1700000000", "history text")])]), "history");
    await drain();
    const [row] = await query(`SELECT text, origin, at FROM messages WHERE id = 'wamid.L1'`);
    expect(row).toEqual({ text: "live text", origin: "live", at: 1700000500000 });
  });

  it("lets a live message replace a history row with the same id", async () => {
    await capture(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.L2", "1700000000", "history text")])]), "history");
    await drain();
    await ingestLive({ type: "reply", from: CUSTOMER, messageId: "wamid.L2", text: "live text", at: 1700000500000 });
    const [row] = await query(`SELECT text, origin FROM messages WHERE id = 'wamid.L2'`);
    expect(row).toEqual({ text: "live text", origin: "live" });
  });
});

describe("direction and media order", () => {
  function photoRow(id: string) {
    return query(`SELECT wa_id, direction, type, text, content FROM messages WHERE id = ?`, id).then(([row]) => ({
      ...row,
      content: JSON.parse(row.content as string),
    }));
  }

  const photo = {
    wa_id: CUSTOMER,
    direction: "echo",
    type: "image",
    text: "Photo",
    content: { media: { id: "MEDIA1", mimeType: "image/jpeg", sha256: "c2hhLWZpeHR1cmU=", caption: "Photo" } },
  };

  it("reads a business-sent message as an echo, and a reprocess rewrites a row stored as an API send", async () => {
    await capture(historyChunk([thread(CUSTOMER, [textMessage(BUSINESS, "wamid.L1", "1700000000", "desde la app")])]), "history");
    await drain();
    // The row a build before this change stored: business-sent history filed as an API send.
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.sql.exec(`UPDATE messages SET direction = 'out' WHERE origin = 'history'`);
    });
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.reprocessSyncPayloads());
    await drain();
    expect(await query(`SELECT direction, origin FROM messages WHERE id = 'wamid.L1'`)).toEqual([
      { direction: "echo", origin: "history" },
    ]);
  });

  it("takes the direction from the thread, not from the display number", async () => {
    await capture(
      envelope("history", {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: OTHER, phone_number_id: "PNID1" },
        history: [
          {
            metadata: { phase: 0, chunk_order: 0, progress: 100 },
            threads: [
              thread(CUSTOMER, [
                textMessage(BUSINESS, "wamid.D1", "1700000000", "sent by us"),
                textMessage(CUSTOMER, "wamid.D2", "1700000060", "from them"),
              ]),
            ],
          },
        ],
      }),
      "history",
    );
    await drain();
    expect(await query(`SELECT id, wa_id, direction FROM messages ORDER BY id`)).toEqual([
      { id: "wamid.D1", wa_id: CUSTOMER, direction: "echo" },
      { id: "wamid.D2", wa_id: CUSTOMER, direction: "in" },
    ]);
  });

  it("keeps an outbound media reference that arrives before its placeholder", async () => {
    await capture(mediaWebhook(BUSINESS, "wamid.OM1", "1700000000", "Photo"), "history");
    await capture(historyChunk([thread(CUSTOMER, [placeholder(BUSINESS, "wamid.OM1", "1700000000")])]), "history");
    await drain();
    expect(await photoRow("wamid.OM1")).toEqual(photo);
    expect(await query(`SELECT id FROM history_media`)).toEqual([]);
  });

  it("completes an outbound placeholder that arrived before its media reference", async () => {
    await capture(historyChunk([thread(CUSTOMER, [placeholder(BUSINESS, "wamid.OM2", "1700000000")])]), "history");
    await drain();
    await capture(mediaWebhook(BUSINESS, "wamid.OM2", "1700000000", "Photo"), "history");
    await drain();
    expect(await photoRow("wamid.OM2")).toEqual(photo);
  });

  it("keeps an inbound media reference that arrives before its placeholder", async () => {
    await capture(mediaWebhook(CUSTOMER, "wamid.IM1", "1700000000", "Photo"), "history");
    await capture(historyChunk([thread(CUSTOMER, [placeholder(CUSTOMER, "wamid.IM1", "1700000000")])]), "history");
    await drain();
    expect(await photoRow("wamid.IM1")).toEqual({ ...photo, direction: "in" });
  });
});

describe("retention window", () => {
  it("does not store a history message older than the workspace window", async () => {
    await setRetention(30);
    const recent = String(Math.floor(Date.now() / 1000) - 3600);
    await capture(
      historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.T1", "1700000000", "old"), textMessage(CUSTOMER, "wamid.T2", recent, "recent")])]),
      "history",
    );
    await drain();
    expect(await query(`SELECT id FROM messages ORDER BY id`)).toEqual([{ id: "wamid.T2" }]);
    expect(await query(`SELECT wa_id FROM contacts`)).toEqual([{ wa_id: CUSTOMER }]);
  });

  it("keeps a synced contact through a sweep, and drops a history contact left with no message", async () => {
    await capture(appState("add", CUSTOMER, "Synced Contact"), "smb_app_state_sync");
    await drain();
    await setRetention(30);
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.sql.exec(`INSERT INTO contacts (wa_id, name, source, updated_at) VALUES (?, NULL, 'history', ?)`, OTHER, Date.now());
    });

    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.pruneConversations(Date.now()));

    expect(await query(`SELECT wa_id, name, source FROM contacts ORDER BY wa_id`)).toEqual([
      { wa_id: CUSTOMER, name: "Synced Contact", source: "app_state" },
    ]);
  });

  it("drops a history contact that a reprocess leaves with no message", async () => {
    await capture(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.P1", "1700000000", "old")])]), "history");
    await drain();
    await setRetention(30);

    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.reprocessSyncPayloads());
    await drain();

    expect(await query(`SELECT id FROM messages`)).toEqual([]);
    expect(await query(`SELECT wa_id FROM contacts`)).toEqual([]);
  });
});

describe("payload limits", () => {
  it("parks a payload over the size cap without reading it", async () => {
    await capture(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.Z1", "1700000000", "hola")])]), "history");
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.sql.exec(`UPDATE sync_payloads SET byte_size = ?`, SYNC_MAX_BYTES + 1);
    });

    await drain();

    const [payload] = await query(`SELECT error, processed_at FROM sync_payloads`);
    expect(payload.error).toMatch(/payload too large/);
    expect(payload.processed_at).not.toBeNull();
    expect(await query(`SELECT id FROM messages`)).toEqual([]);
  });

  it("parks a payload whose runs keep aborting once its attempts are used up", async () => {
    await capture(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.Z2", "1700000000", "hola")])]), "history");
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      i.sql.exec(`UPDATE sync_payloads SET attempts = ?`, SYNC_MAX_ATTEMPTS);
    });

    await drain();

    const [payload] = await query(`SELECT error, processed_at FROM sync_payloads`);
    expect(payload.error).toBe(`gave up after ${SYNC_MAX_ATTEMPTS} failed runs`);
    expect(payload.processed_at).not.toBeNull();
    expect(await query(`SELECT id FROM messages`)).toEqual([]);
  });
});

describe("app-state contacts", () => {
  it("adds a contact name on add and clears only the name on remove", async () => {
    await capture(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.C1", "1700000000", "hola")])]), "history");
    await drain();
    await capture(appState("add", CUSTOMER, "Test Contact"), "smb_app_state_sync");
    await drain();
    expect((await query(`SELECT name, source FROM contacts WHERE wa_id = ?`, CUSTOMER))[0]).toEqual({
      name: "Test Contact",
      source: "app_state",
    });

    await capture(appState("remove", CUSTOMER), "smb_app_state_sync");
    await drain();
    expect((await query(`SELECT name FROM contacts WHERE wa_id = ?`, CUSTOMER))[0]).toEqual({ name: null });
    expect(await query(`SELECT id FROM messages WHERE wa_id = ?`, CUSTOMER)).toHaveLength(1);
  });

  it("stores a BSUID-only contact, and merges it into the phone once a contact names both", async () => {
    const bsuid = "US.13491208655302741918";
    const contact = (fields: Record<string, unknown>) =>
      envelope("smb_app_state_sync", {
        messaging_product: "whatsapp",
        metadata: METADATA,
        state_sync: [{ type: "contact", contact: { full_name: "Ana", ...fields }, action: "add", metadata: { timestamp: "1700000000" } }],
      });
    await capture(historyChunk([thread(bsuid, [{ ...textMessage(CUSTOMER, "wamid.C1", "1700000000", "hola"), from: undefined, from_user_id: bsuid }])]), "history");
    await capture(contact({ user_id: bsuid }), "smb_app_state_sync");
    await drain();
    expect(await query(`SELECT wa_id, name FROM contacts`)).toEqual([{ wa_id: bsuid, name: "Ana" }]);

    await capture(contact({ user_id: bsuid, phone_number: CUSTOMER }), "smb_app_state_sync");
    await drain();
    expect(await query(`SELECT wa_id, name, source FROM contacts`)).toEqual([{ wa_id: CUSTOMER, name: "Ana", source: "app_state" }]);
    expect(await query(`SELECT id, wa_id FROM messages`)).toEqual([{ id: "wamid.C1", wa_id: CUSTOMER }]);
  });
});

describe("reprocessing", () => {
  it("rebuilds identical messages and contacts, with no duplicates", async () => {
    await capture(
      historyChunk([
        thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.R1", "1700000000", "hola"), placeholder(CUSTOMER, "wamid.R2", "1700000010")]),
        thread(OTHER, [textMessage(BUSINESS, "wamid.R3", "1700000020", "hi", "SENT")]),
      ]),
      "history",
    );
    await capture(mediaWebhook(CUSTOMER, "wamid.R2", "1700000010", "Photo"), "history");
    await capture(appState("add", OTHER, "Other Contact"), "smb_app_state_sync");
    await drain();
    const first = await snapshot();

    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.reprocessSyncPayloads());
    await drain();
    expect(await snapshot()).toEqual(first);
    expect(first.messages).toHaveLength(3);
  });

  it("does not bring an erased number back", async () => {
    await capture(
      historyChunk([
        thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.E1", "1700000000", "secret")]),
        thread(OTHER, [textMessage(OTHER, "wamid.E2", "1700000000", "kept")]),
      ]),
      "history",
    );
    await capture(appState("add", CUSTOMER, "Erased Contact"), "smb_app_state_sync");
    await drain();

    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.eraseByPhone(`+${CUSTOMER}`));
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => i.reprocessSyncPayloads());
    await drain();

    expect(await query(`SELECT id FROM messages WHERE wa_id = ?`, CUSTOMER)).toEqual([]);
    expect(await query(`SELECT wa_id FROM contacts WHERE wa_id = ?`, CUSTOMER)).toEqual([]);
    expect((await query(`SELECT id FROM messages`)).map((row) => row.id)).toEqual(["wamid.E2"]);
  });

  it("applies a payload larger than one batch in bounded passes", async () => {
    const messages = Array.from({ length: 450 }, (_, n) =>
      textMessage(CUSTOMER, `wamid.B${n}`, String(1700000000 + n), `m${n}`),
    );
    const passes = await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      await i.captureSyncPayload(["history"], JSON.stringify(historyChunk([thread(CUSTOMER, messages)])));
      const batch = i as unknown as { processSyncBatch(now: number): Promise<number | null> };
      const out: Array<{ pending: boolean; cursor: number }> = [];
      for (let pass = 0; pass < 3; pass++) {
        const delay = await batch.processSyncBatch(Date.now());
        out.push({ pending: delay !== null, cursor: Number(i.sql.exec(`SELECT cursor FROM sync_payloads`).one().cursor) });
      }
      return out;
    });
    expect(passes).toEqual([
      { pending: true, cursor: 200 },
      { pending: true, cursor: 400 },
      { pending: false, cursor: 450 },
    ]);
    expect((await query(`SELECT COUNT(*) AS n FROM messages`))[0].n).toBe(450);
  });

  it("finishes a large payload through the alarm's own re-arming", async () => {
    const messages = Array.from({ length: 450 }, (_, n) =>
      textMessage(CUSTOMER, `wamid.D${n}`, String(1700000000 + n), `m${n}`),
    );
    await capture(historyChunk([thread(CUSTOMER, messages)]), "history");
    await drain();
    // Progress clears the attempts, so a long payload is never parked for taking many wakes.
    expect((await query(`SELECT processed_at, cursor, attempts FROM sync_payloads`))[0]).toEqual({
      processed_at: expect.any(Number),
      cursor: 450,
      attempts: 0,
    });
    expect((await query(`SELECT COUNT(*) AS n FROM messages`))[0].n).toBe(450);
  });
});

describe("alarm wake", () => {
  it("wakes at once for a payload captured while the alarm runs, not at the backlog's later wake", async () => {
    await capture(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.W1", "1700000000", "uno")])]), "history");
    const armedAt = await runInDurableObject(gatewayStub(), async (i: EccosGateway) => {
      const sync = i as unknown as { runSyncBatch: (now: number) => Promise<number | null>; ctx: DurableObjectState };
      const original = sync.runSyncBatch;
      // Stands in for a sync pass that leaves a backlog a minute out, while a new payload lands mid-run.
      sync.runSyncBatch = async () => {
        sync.runSyncBatch = original;
        await i.captureSyncPayload(["history"], JSON.stringify(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.W2", "1700000060", "dos")])])));
        return 60_000;
      };
      await i.alarm();
      return sync.ctx.storage.getAlarm();
    });
    expect(armedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("worker webhook", () => {
  it("captures a history webhook and processes it from the alarm", async () => {
    const body = JSON.stringify(historyChunk([thread(CUSTOMER, [textMessage(CUSTOMER, "wamid.W1", "1700000000", "hola")])]));
    const response = await exports.default.fetch("http://example.com/webhooks/meta", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET) },
      body,
    });
    expect(response.status).toBe(200);
    await drain();
    expect((await query(`SELECT id FROM messages`))).toEqual([{ id: "wamid.W1" }]);
  });
});

describe("history sharing off reaches the control plane", () => {
  const COEX_ACCOUNT = "acc-hist-coex";
  const COEX_WABA = "WABA_HIST_COEX";

  function sharingOff(wabaId: string) {
    return envelope(
      "history",
      {
        messaging_product: "whatsapp",
        metadata: METADATA,
        history: [{ errors: [{ code: 2593109, title: "History sharing is off", message: "Sharing is off" }] }],
      },
      wabaId,
    );
  }

  async function controlPlaneWaba(wabaId: string): Promise<Record<string, unknown>> {
    return runInDurableObject(getControlPlaneStub(env), (cp: EccosControlPlane) =>
      cp.sql.exec("SELECT coexistence_sync_status, history_sync_request_id FROM wabas WHERE waba_id = ?", wabaId).toArray()[0],
    );
  }

  it("records the refusal on the coexistence WABA the payload belongs to, once", async () => {
    await runInDurableObject(getControlPlaneStub(env), async (cp: EccosControlPlane) => {
      await cp.createAccount({ accountId: COEX_ACCOUNT });
      await cp.beginWabaProvisioning({
        accountId: COEX_ACCOUNT,
        wabaId: COEX_WABA,
        metaAccessToken: "tenant-token",
        callbackUrl: "https://gateway.example/webhooks/meta",
        onboardingType: "coexistence",
        phones: [{ phoneNumberId: "PNID_HIST", displayPhoneNumber: "+34600000003" }],
      });
    });
    const coexStub = getGatewayStubForWaba(env, COEX_WABA);
    await runInDurableObject(coexStub, (i: EccosGateway) =>
      i.captureSyncPayload(["history"], JSON.stringify(sharingOff(COEX_WABA))),
    );

    await runInDurableObject(coexStub, (i: EccosGateway) =>
      (i as unknown as { processSyncBatch(now: number): Promise<boolean> }).processSyncBatch(Date.now()),
    );

    // The contacts sync is still pending, so the status is what that leaves, not "unavailable".
    expect(await controlPlaneWaba(COEX_WABA)).toEqual({
      coexistence_sync_status: "pending",
      history_sync_request_id: "unavailable:history_sharing_off",
    });
    expect(await query(`SELECT value FROM config WHERE key = '__history_sharing_off__'`)).toEqual([]);
  });

  it("leaves a standard WABA's control-plane record alone", async () => {
    await capture(sharingOff(TEST_WABA_ID), "history");
    await drain();

    expect(await controlPlaneWaba(TEST_WABA_ID)).toEqual({
      coexistence_sync_status: "not_applicable",
      history_sync_request_id: null,
    });
  });
});
