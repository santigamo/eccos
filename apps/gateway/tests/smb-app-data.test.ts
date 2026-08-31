import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  SMB_APP_DATA_EDGE,
  SMB_APP_DATA_SYNC_TYPE,
  initiateContactsSync,
  initiateHistorySync,
} from "../src/meta/smb-app-data";
import { MetaGraphError } from "../src/meta/connect-api";

/**
 * Pins the SMB App Data contract as read from Meta's own onboarding guide on
 * 2026-08-31 (see the header of `src/meta/smb-app-data.ts` for the URL and the
 * verbatim curl examples). If Meta changes the shape, this is the test that
 * should break first — and it is the only place besides that module that knows
 * the shape at all.
 */

const CFG = { META_GRAPH_VERSION: "v25.0" };
const TOKEN = "biz-token";
const PHONE = "PN_123";

type Captured = { url: string; init: RequestInit };

function captureFetch(response: Response): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  }) as unknown as typeof fetch;
  return { calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ok(body: unknown = { messaging_product: "whatsapp", request_id: "REQ_1" }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("SMB App Data sync requests", () => {
  test("posts to the phone number node, not the WABA", async () => {
    const { calls } = captureFetch(ok());
    await initiateHistorySync(CFG, PHONE, TOKEN);
    expect(calls).toHaveLength(1);
    // Meta's example: POST /<API_VERSION>/<BUSINESS_PHONE_NUMBER_ID>/smb_app_data
    expect(calls[0]!.url).toBe(
      `https://graph.facebook.com/v25.0/${PHONE}/${SMB_APP_DATA_EDGE}`,
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  test("sends JSON with messaging_product and the documented sync_type values", async () => {
    const { calls } = captureFetch(ok());
    await initiateContactsSync(CFG, PHONE, TOKEN);
    await initiateHistorySync(CFG, PHONE, TOKEN);

    const bodies = calls.map((call) => JSON.parse(String(call.init.body)));
    // Contacts is `smb_app_state_sync` — lowercase, and NOT "contacts".
    expect(bodies[0]).toEqual({ messaging_product: "whatsapp", sync_type: "smb_app_state_sync" });
    expect(bodies[1]).toEqual({ messaging_product: "whatsapp", sync_type: "history" });
    expect(SMB_APP_DATA_SYNC_TYPE.contacts).toBe("smb_app_state_sync");
    expect(SMB_APP_DATA_SYNC_TYPE.history).toBe("history");

    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/json");
      // Meta's example for this endpoint omits `Bearer`; the same page includes
      // it on the adjacent call, so it is read as a documentation typo.
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("returns Meta's request_id, which the guide says to keep for support", async () => {
    captureFetch(ok({ messaging_product: "whatsapp", request_id: "REQ_ABC" }));
    expect(await initiateHistorySync(CFG, PHONE, TOKEN)).toEqual({ requestId: "REQ_ABC" });
  });

  test("acceptance is the 2xx, not a `success` field Meta never documents", async () => {
    // Third-party clients expect `success: boolean`; Meta's documented body has
    // no such field. Keying off it would reject a perfectly good acceptance.
    captureFetch(ok({ messaging_product: "whatsapp" }));
    expect(await initiateContactsSync(CFG, PHONE, TOKEN)).toEqual({ requestId: null });
  });

  test("a non-JSON 200 is still an acceptance", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    expect(await initiateHistorySync(CFG, PHONE, TOKEN)).toEqual({ requestId: null });
  });

  test("a non-2xx throws MetaGraphError carrying the status", async () => {
    captureFetch(
      new Response(
        JSON.stringify({
          error: {
            message: "Synchronization request can only be made within 24 hours of onboarding",
            code: 2593108,
          },
        }),
        { status: 400 },
      ),
    );
    const error = await initiateHistorySync(CFG, PHONE, TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaGraphError);
    expect((error as MetaGraphError).status).toBe(400);
    expect((error as MetaGraphError).message).toContain("within 24 hours");
  });
});
