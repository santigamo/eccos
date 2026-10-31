import { env, exports } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { getMedia } from "../../src/media-store";
import { alarmOf, bootstrapAccount, gatewayStub, holdAlarms, runAlarm, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

const WA = "34600000001";
const OTHER = "34600000002";
const BYTES = "fake-jpeg-bytes-for-the-media-spec";
const LOOKASIDE = "https://lookaside.example/cdn";
const DAY_MS = 24 * 60 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
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

let apiKey = "ek-test";

beforeEach(async () => {
  apiKey = (await bootstrapAccount()).apiKey;
  await holdAlarms();
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

  it("reads a base64 SHA-256 from Meta and stores the digest in R2 as hex", async () => {
    fakeMeta({
      "1007": async () =>
        Response.json({ url: `${LOOKASIDE}/1007`, mime_type: "image/jpeg", sha256: await sha256Base64(BYTES), file_size: BYTES.length, id: "1007" }),
    });
    await gatewayStub().ingest([imageEvent("1007")]);

    await runAlarm();

    expect(await mediaRow("1007")).toMatchObject({ state: "stored", attempts: 1 });
    expect((await getMedia(env.MEDIA, TEST_WABA_ID, "1007"))!.sha256).toBe(await sha256Hex(BYTES));
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

describe("media download (DO alarm) under a rejected token and a mid-alarm webhook", () => {
  it("counts no attempt when Meta rejects the token, and stores the media once the token is fixed", async () => {
    let rejected = true;
    const meta = fakeMeta({
      "1020": async () =>
        rejected
          ? Response.json({ error: { message: "Invalid OAuth access token", code: 190 } }, { status: 400 })
          : Response.json({ url: `${LOOKASIDE}/1020`, mime_type: "image/jpeg", sha256: await sha256Hex(BYTES), file_size: BYTES.length, id: "1020" }),
    });
    await gatewayStub().ingest([imageEvent("1020")]);

    await runAlarm();
    expect(await mediaRow("1020")).toBeNull();
    const before = graphCalls(meta).length;
    await runAlarm();
    expect(graphCalls(meta).length).toBeGreaterThan(before);
    expect(await mediaRow("1020")).toBeNull();

    rejected = false;
    await runAlarm();

    expect(await mediaRow("1020")).toMatchObject({ state: "stored", attempts: 1 });
  });

  it("wakes again at once while due media remain, instead of at the next retry", async () => {
    fakeMeta();
    await gatewayStub().ingest(["2101", "2102", "2103", "2104", "2105", "2106"].map((id) => imageEvent(id)));

    const armedAt = await runInDurableObject(gatewayStub(), async (instance: EccosGateway, state: DurableObjectState) => {
      await state.storage.deleteAlarm();
      await alarmOf(instance);
      return state.storage.getAlarm();
    });

    expect(armedAt).not.toBeNull();
    expect(armedAt!).toBeLessThanOrEqual(Date.now());
  });

  it("wakes at once for a webhook that lands mid-alarm, rather than at a failed download's retry time", async () => {
    let arrived = false;
    const meta = fakeMeta({ "8001": () => new Response("busy", { status: 503 }) });
    const serve = meta.getMockImplementation()!;
    await gatewayStub().ingest([imageEvent("8001")]);

    const armedAt = await runInDurableObject(gatewayStub(), async (instance: EccosGateway, state: DurableObjectState) => {
      meta.mockImplementation(async (input, init) => {
        if (String(input).includes("/8001") && !arrived) {
          arrived = true;
          await instance.ingest([imageEvent("8002")]);
        }
        return serve(input, init);
      });
      await state.storage.deleteAlarm();
      await alarmOf(instance);
      return state.storage.getAlarm();
    });

    expect(await mediaRow("8001")).toMatchObject({ state: "failed", attempts: 1 });
    expect(armedAt!).toBeLessThanOrEqual(Date.now());
  });

  it("reports a checksum mismatch distinctly, and still counts it as an attempt", async () => {
    const warn = vi.spyOn(console, "warn");
    fakeMeta({
      "8101": async () =>
        Response.json({ url: `${LOOKASIDE}/8101`, mime_type: "image/jpeg", sha256: await sha256Hex("other"), file_size: BYTES.length, id: "8101" }),
    });
    await gatewayStub().ingest([imageEvent("8101")]);

    await runAlarm();

    expect(await mediaRow("8101")).toMatchObject({ state: "failed", attempts: 1 });
    expect(warn.mock.calls.some(([line]) => String(line).includes('"event":"checksum-mismatch"'))).toBe(true);
  });
});

describe("history media (DO alarm)", () => {
  it("downloads the media of a captured history webhook in the same alarm that imports it", async () => {
    const meta = fakeMeta();
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: TEST_WABA_ID,
          changes: [
            {
              field: "history",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: WA, phone_number_id: "PNID1" },
                messages: [
                  {
                    from: OTHER,
                    id: "wamid.H7001",
                    timestamp: "1700000000",
                    type: "image",
                    image: { id: "7001", mime_type: "image/jpeg", sha256: "c2hhLWZpeHR1cmU=", caption: "Photo" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await runInDurableObject(gatewayStub(), (i: EccosGateway) =>
      i.captureSyncPayload(["history"], JSON.stringify(body)),
    );
    expect(meta).not.toHaveBeenCalled();

    await runAlarm();

    const [row] = await runInDurableObject(gatewayStub(), (i: EccosGateway) =>
      i.sql.exec(`SELECT origin, content FROM messages WHERE id = 'wamid.H7001'`).toArray(),
    );
    expect(row).toMatchObject({ origin: "history" });
    expect(JSON.parse(row.content as string).media.id).toBe("7001");
    const stored = await getMedia(env.MEDIA, TEST_WABA_ID, "7001");
    expect(stored).not.toBeNull();
    expect(await new Response(stored!.body).text()).toBe(BYTES);
    expect(await mediaRow("7001")).toMatchObject({ state: "stored", attempts: 1 });
  });
});

describe("erasure when R2 refuses the delete", () => {
  it("returns a retryable result, and the repeated erasure finishes the work", async () => {
    fakeMeta();
    await gatewayStub().ingest([imageEvent("3101")]);
    await runAlarm();
    vi.spyOn(env.MEDIA, "delete").mockRejectedValueOnce(new Error("R2 unavailable"));

    const first = await gatewayStub().eraseByPhone(WA);

    expect(first).toEqual({ ok: false, error: expect.stringContaining("retry"), retryable: true });
    expect(await mediaRow("3101")).toMatchObject({ state: "erased" });

    const second = await gatewayStub().eraseByPhone(WA);

    expect(second.ok).toBe(true);
    expect(await storedIds()).toEqual([]);
  });

  it("answers the public route 503 with a retry message, and logs the erasure", async () => {
    fakeMeta();
    await gatewayStub().ingest([imageEvent("3102")]);
    await runAlarm();
    vi.spyOn(env.MEDIA, "delete").mockRejectedValueOnce(new Error("R2 unavailable"));
    const log = vi.spyOn(console, "log");

    const res = await exports.default.fetch(`http://example.com/v1/wabas/${TEST_WABA_ID}/privacy/erasure`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ phone: WA }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/retry/);
    expect(log.mock.calls.some(([line]) => String(line).includes('"event":"privacy_erasure"') && String(line).includes('"status":503'))).toBe(true);
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

  it("refuses an erased media id even while its object is still in R2", async () => {
    fakeMeta();
    await gatewayStub().ingest([imageEvent("5010")]);
    await runAlarm();
    await runInDurableObject(gatewayStub(), (instance: EccosGateway) =>
      instance.sql.exec(`UPDATE media SET state = 'erased' WHERE media_id = '5010'`),
    );
    expect(await getMedia(env.MEDIA, TEST_WABA_ID, "5010")).not.toBeNull();
    const rpc = new GatewayRPC(createExecutionContext(), env);

    expect(await rpc.getMedia({ wabaId: TEST_WABA_ID, mediaId: "5010" }, TEST_ACCOUNT_ID)).toBeNull();
  });

  it("serves only the requested byte range, and reports the range it resolved", async () => {
    fakeMeta();
    await gatewayStub().ingest([imageEvent("5011")]);
    await runAlarm();
    const rpc = new GatewayRPC(createExecutionContext(), env);

    const middle = await rpc.getMedia({ wabaId: TEST_WABA_ID, mediaId: "5011", range: { offset: 4, length: 6 } }, TEST_ACCOUNT_ID);
    expect(middle!.range).toEqual({ offset: 4, length: 6 });
    expect(middle!.size).toBe(BYTES.length);
    expect(await new Response(middle!.body).text()).toBe(BYTES.slice(4, 10));

    const tail = await rpc.getMedia({ wabaId: TEST_WABA_ID, mediaId: "5011", range: { suffix: 5 } }, TEST_ACCOUNT_ID);
    expect(tail!.range).toEqual({ offset: BYTES.length - 5, length: 5 });
    expect(await new Response(tail!.body).text()).toBe(BYTES.slice(-5));
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
