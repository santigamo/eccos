import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { getMedia } from "../../src/media-store";
import { bootstrapAccount, gatewayStub, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const WA = "34600000001";
const OTHER = "34600000002";
const BYTES = "fake-jpeg-bytes-for-the-media-spec";
const LOOKASIDE = "https://lookaside.example/cdn";
const DAY_MS = 24 * 60 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function imageEvent(mediaId: string, at = Date.now(), from = WA): WhatsAppCallbackEvent {
  return {
    type: "message",
    from,
    messageId: `wamid.${mediaId}`,
    at,
    phoneNumberId: "PNID1",
    messageType: "image",
    media: { id: mediaId, mimeType: "image/jpeg" },
  };
}

type MetaReply = () => Response | Promise<Response>;

/**
 * A Meta that answers the two steps the downloader takes: the id lookup on Graph,
 * then the CDN URL it names. `replies` overrides the lookup for one media id.
 * Every request must carry the WABA's token, as the real CDN requires.
 */
function fakeMeta(replies: Record<string, MetaReply> = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== "Bearer tenant-token") return new Response("unauthorized", { status: 401 });
    if (url.startsWith("https://graph.facebook.com/v25.0/")) {
      const mediaId = url.split("/").pop()!;
      if (replies[mediaId]) return replies[mediaId]!();
      return Response.json({
        url: `${LOOKASIDE}/${mediaId}`,
        mime_type: "image/jpeg",
        sha256: await sha256Hex(BYTES),
        file_size: BYTES.length,
        id: mediaId,
      });
    }
    if (url.startsWith(`${LOOKASIDE}/`)) return new Response(BYTES, { headers: { "content-type": "image/jpeg" } });
    throw new Error(`unexpected fetch to ${url}`);
  });
}

function graphCalls(spy: ReturnType<typeof fakeMeta>): string[] {
  return spy.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("graph.facebook.com"));
}

/** Runs the alarm directly, as alarm.spec.ts does: an alarm due "now" is not reliably
 * fired by the harness right after an ingest. */
async function runAlarm(): Promise<void> {
  await runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.alarm());
}

async function mediaRow(mediaId: string) {
  return runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
    instance.sql.exec(`SELECT state, attempts, last_error, next_attempt_at FROM media WHERE media_id = ?`, mediaId).toArray()[0] ?? null,
  );
}

async function setMediaRow(mediaId: string, values: { attempts: number; next_attempt_at: number }) {
  await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
    instance.sql.exec(
      `UPDATE media SET attempts = ?, next_attempt_at = ? WHERE media_id = ?`,
      values.attempts,
      values.next_attempt_at,
      mediaId,
    );
  });
}

async function storedIds(): Promise<string[]> {
  return (await env.MEDIA.list({ prefix: `waba/${TEST_WABA_ID}/media/` })).objects.map((object) =>
    object.key.split("/").pop()!,
  );
}

beforeEach(async () => {
  await bootstrapAccount();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("media download (DO alarm)", () => {
  it("does not download in the webhook path, and stores the bytes on the alarm with Meta's type and digest", async () => {
    const meta = fakeMeta();
    await gatewayStub().ingest([imageEvent("1001")]);
    expect(meta).not.toHaveBeenCalled();

    await runAlarm();

    expect(graphCalls(meta)).toHaveLength(1);
    expect(meta.mock.calls.map(([input]) => String(input))).toContain(`${LOOKASIDE}/1001`);
    const stored = await getMedia(env.MEDIA, TEST_WABA_ID, "1001");
    expect(stored).not.toBeNull();
    expect(await new Response(stored!.body).text()).toBe(BYTES);
    expect(stored!.contentType).toBe("image/jpeg");
    expect(stored!.sha256).toBe(await sha256Hex(BYTES));
    expect(await mediaRow("1001")).toMatchObject({ state: "stored", attempts: 1 });
  });

  it("refuses bytes whose SHA-256 is not Meta's, and retries that as a transient failure", async () => {
    fakeMeta({
      "1002": async () =>
        Response.json({ url: `${LOOKASIDE}/1002`, mime_type: "image/jpeg", sha256: await sha256Hex("other"), file_size: BYTES.length, id: "1002" }),
    });
    await gatewayStub().ingest([imageEvent("1002")]);

    await runAlarm();

    expect(await getMedia(env.MEDIA, TEST_WABA_ID, "1002")).toBeNull();
    const row = await mediaRow("1002");
    expect(row).toMatchObject({ state: "failed", attempts: 1 });
    expect(row!.next_attempt_at as number).toBeGreaterThan(Date.now());
  });

  it("gives up at once when Meta says the id has expired", async () => {
    const meta = fakeMeta({
      "1003": () => Response.json({ error: { message: "Object does not exist", code: 100, error_subcode: 33 } }, { status: 400 }),
    });
    await gatewayStub().ingest([imageEvent("1003")]);

    await runAlarm();
    await runAlarm();

    expect(await mediaRow("1003")).toMatchObject({ state: "gone", attempts: 1 });
    expect(graphCalls(meta).filter((url) => url.endsWith("/1003"))).toHaveLength(1);
  });

  it("refuses a file over the size limit without fetching its bytes", async () => {
    const meta = fakeMeta({
      "1004": () =>
        Response.json({ url: `${LOOKASIDE}/1004`, mime_type: "video/mp4", sha256: null, file_size: 101 * 1024 * 1024, id: "1004" }),
    });
    await gatewayStub().ingest([imageEvent("1004")]);

    await runAlarm();

    expect(await mediaRow("1004")).toMatchObject({ state: "gone" });
    expect(meta.mock.calls.map(([input]) => String(input))).not.toContain(`${LOOKASIDE}/1004`);
  });

  it("retries a transient failure only once its backoff has passed, then stores it", async () => {
    let fail = true;
    const meta = fakeMeta({
      "1005": async () => (fail ? new Response("busy", { status: 503 }) : Response.json({ url: `${LOOKASIDE}/1005`, mime_type: "image/jpeg", sha256: await sha256Hex(BYTES), file_size: BYTES.length, id: "1005" })),
    });
    await gatewayStub().ingest([imageEvent("1005")]);

    await runAlarm();
    expect(await mediaRow("1005")).toMatchObject({ state: "failed", attempts: 1 });
    await runAlarm();
    expect(graphCalls(meta).filter((url) => url.endsWith("/1005"))).toHaveLength(1);

    fail = false;
    await setMediaRow("1005", { attempts: 1, next_attempt_at: Date.now() - 1 });
    await runAlarm();

    expect(await mediaRow("1005")).toMatchObject({ state: "stored", attempts: 2, last_error: null });
    expect(await getMedia(env.MEDIA, TEST_WABA_ID, "1005")).not.toBeNull();
  });

  it("gives up after the attempt limit", async () => {
    fakeMeta({ "1006": () => new Response("busy", { status: 503 }) });
    await gatewayStub().ingest([imageEvent("1006")]);
    await runAlarm();
    await setMediaRow("1006", { attempts: 4, next_attempt_at: 0 });

    await runAlarm();

    expect(await mediaRow("1006")).toMatchObject({ state: "gone", attempts: 5 });
  });

  it("downloads at most one batch per alarm and leaves the rest for the next one", async () => {
    fakeMeta();
    const ids = ["2001", "2002", "2003", "2004", "2005", "2006", "2007"];
    await gatewayStub().ingest(ids.map((id, i) => imageEvent(id, Date.now() + i)));

    await runAlarm();
    expect(await storedIds()).toHaveLength(5);

    await runAlarm();
    expect((await storedIds()).sort()).toEqual(ids);
  });

  it("keeps no object for a message removed while its bytes were in flight", async () => {
    const meta = fakeMeta();
    const serve = meta.getMockImplementation()!;
    let instance!: EccosGateway;
    await runInDurableObject(gatewayStub(), (i: EccosGateway) => {
      instance = i;
    });
    meta.mockImplementation(async (input, init) => {
      // What an erasure or a retention prune does, landing during the CDN download.
      if (String(input).startsWith(LOOKASIDE)) instance.sql.exec(`DELETE FROM messages WHERE wa_id = ?`, WA);
      return serve(input, init);
    });
    await gatewayStub().ingest([imageEvent("6001")]);

    await runAlarm();

    expect(await storedIds()).toEqual([]);
    expect(await mediaRow("6001")).toBeNull();
  });

  it("erasure deletes the R2 objects of that number's media and nothing else", async () => {
    fakeMeta();
    await gatewayStub().ingest([imageEvent("3001"), imageEvent("3002", Date.now(), OTHER)]);
    await runAlarm();
    expect((await storedIds()).sort()).toEqual(["3001", "3002"]);

    const result = await gatewayStub().eraseByPhone(WA);

    expect(result.ok).toBe(true);
    expect(await getMedia(env.MEDIA, TEST_WABA_ID, "3001")).toBeNull();
    expect(await storedIds()).toEqual(["3002"]);
    expect(await mediaRow("3001")).toBeNull();
  });

  it("retention deletes the R2 objects of the messages it prunes", async () => {
    fakeMeta();
    await gatewayStub().ingest([imageEvent("4001", Date.now() - 40 * DAY_MS), imageEvent("4002", Date.now())]);
    await runAlarm();
    expect((await storedIds()).sort()).toEqual(["4001", "4002"]);

    // Turn the window on, and make the next alarm run the hourly sweep.
    await runInDurableObject(getControlPlaneStub(env), (cp) => cp.setConversationRetentionDays(TEST_ACCOUNT_ID, 30));
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) => instance.saveConfig({ __last_sweep_at__: "0" }));
    await runAlarm();

    expect((await storedIds()).sort()).toEqual(["4002"]);
    expect(await mediaRow("4001")).toBeNull();
  });
});

describe("GatewayRPC.getMedia", () => {
  it("streams a stored object to the account that owns its WABA", async () => {
    fakeMeta();
    await gatewayStub().ingest([imageEvent("5001")]);
    await runAlarm();
    const rpc = new GatewayRPC(createExecutionContext(), env);

    const media = await rpc.getMedia({ wabaId: TEST_WABA_ID, mediaId: "5001" }, TEST_ACCOUNT_ID);

    expect(media).not.toBeNull();
    expect(media!.contentType).toBe("image/jpeg");
    expect(media!.size).toBe(BYTES.length);
    expect(await new Response(media!.body).text()).toBe(BYTES);
  });

  it("returns null for a media id that is not stored", async () => {
    const rpc = new GatewayRPC(createExecutionContext(), env);
    expect(await rpc.getMedia({ wabaId: TEST_WABA_ID, mediaId: "5002" }, TEST_ACCOUNT_ID)).toBeNull();
  });

  it("refuses a WABA the calling account does not own, before touching R2", async () => {
    await bootstrapAccount("foreign-account", "WABA_FOREIGN", [{ phoneNumberId: "PNID9" }]);
    await env.MEDIA.put(`waba/${TEST_WABA_ID}/media/5003`, "secret", { httpMetadata: { contentType: "image/jpeg" } });
    const rpc = new GatewayRPC(createExecutionContext(), env);

    await expect(rpc.getMedia({ wabaId: TEST_WABA_ID, mediaId: "5003" }, "foreign-account")).rejects.toThrow(
      /not owned by account/,
    );
  });
});
