import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTemplate, deleteTemplate } from "@eccos/core/templates";
import type { MetaAppConfig } from "@eccos/core/config-schema";

/**
 * The Graph request shape for template authoring (`src/templates.ts`).
 *
 * These helpers are pure Cloud API wrappers, so what is worth pinning is the
 * REQUEST — the URL, the method, the auth header and the exact JSON body. A
 * drifted `example` nesting or a delete that degrades to its name-only form
 * fails silently at Meta (or, worse, succeeds and does the wrong thing), which
 * no type can catch.
 */

const CFG: MetaAppConfig = {
  META_GRAPH_VERSION: "v25.0",
  META_ACCESS_TOKEN: "token",
  META_WABA_ID: "WABA_TEST",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(response: () => Response): { requests: { url: string; init?: RequestInit }[] } {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    return response();
  };
  return { requests };
}

const created = () =>
  new Response(JSON.stringify({ id: "1234567890", status: "PENDING", category: "UTILITY" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("createTemplate", () => {
  it("posts the WABA's message_templates endpoint with the exact Graph body", () => {
    // The request IS the product here: Meta reads `example.body_text` as an
    // ARRAY OF ARRAYS, and a flat array creates templates that are rejected at
    // review rather than at create time — a failure nobody would trace back.
    const { requests } = stubFetch(created);
    return createTemplate(CFG, {
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      bodyText: "Hi {{1}}, order {{2}} shipped.",
      examples: ["Ada", "A-1029"],
    }).then((result) => {
      expect(result).toEqual({
        ok: true,
        data: { id: "1234567890", status: "PENDING", category: "UTILITY" },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://graph.facebook.com/v25.0/WABA_TEST/message_templates",
      );
      expect(requests[0]?.init?.method).toBe("POST");
      expect(requests[0]?.init?.headers).toMatchObject({
        authorization: "Bearer token",
        "content-type": "application/json",
      });
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
        name: "order_update",
        language: "en_US",
        category: "UTILITY",
        components: [
          {
            type: "BODY",
            text: "Hi {{1}}, order {{2}} shipped.",
            example: { body_text: [["Ada", "A-1029"]] },
          },
        ],
      });
    });
  });

  it("never sends `allow_category_change` or `parameter_format`", async () => {
    // Both are stale advice. Meta recategorises regardless (it is now the
    // default behaviour) and POSITIONAL is the default format — sending either
    // adds nothing and invites drift between what we ask for and what we get.
    const { requests } = stubFetch(created);
    await createTemplate(CFG, {
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      bodyText: "Hi",
    });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body).not.toHaveProperty("allow_category_change");
    expect(body).not.toHaveProperty("parameter_format");
  });

  it("omits `example` entirely for a zero-parameter body", async () => {
    // An empty example object is a shape Meta has no reason to accept, and the
    // zero-parameter template is exactly the one filmed for App Review.
    const { requests } = stubFetch(created);
    await createTemplate(CFG, {
      name: "welcome",
      language: "en_US",
      category: "MARKETING",
      bodyText: "Welcome and congratulations!",
      examples: [],
    });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.components[0]).not.toHaveProperty("example");
  });

  it("passes Meta's error envelope through untouched, and a throw as status 0", async () => {
    // Core reports, callers decide — the same division `listTemplates` draws.
    // The gateway is what turns an envelope into the console's closed
    // vocabulary; if core interpreted it, there would be two mappings.
    const envelope = { error: { message: "name exists", code: 100, error_subcode: 2388024 } };
    stubFetch(
      () =>
        new Response(JSON.stringify(envelope), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(
      await createTemplate(CFG, {
        name: "taken",
        language: "en_US",
        category: "UTILITY",
        bodyText: "Hi",
      }),
    ).toEqual({ ok: false, status: 400, error: envelope });

    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    expect(
      await createTemplate(CFG, {
        name: "taken",
        language: "en_US",
        category: "UTILITY",
        bodyText: "Hi",
      }),
    ).toEqual({ ok: false, status: 0, error: "network down" });
  });

  it("refuses to call Meta without a WABA id", async () => {
    const { requests } = stubFetch(created);
    const result = await createTemplate(
      { META_ACCESS_TOKEN: "token" },
      { name: "x", language: "en_US", category: "UTILITY", bodyText: "Hi" },
    );
    expect(result).toEqual({ ok: false, status: 0, error: "META_WABA_ID is not configured" });
    expect(requests).toHaveLength(0);
  });
});

describe("deleteTemplate", () => {
  it("deletes ONE translation, by hsm_id, with both parameters URL-encoded", async () => {
    // The name-only form of this endpoint deletes EVERY language of the
    // template. The row an operator clicked is one name+language pair, so the
    // per-translation form is the only one this helper can express — and this
    // assertion is what keeps it that way.
    const { requests } = stubFetch(
      () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await deleteTemplate(CFG, { name: "order update", hsmId: "1234567890" });
    expect(result).toEqual({ ok: true, data: { success: true } });
    expect(requests[0]?.init?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe(
      "https://graph.facebook.com/v25.0/WABA_TEST/message_templates?name=order+update&hsm_id=1234567890",
    );
  });

  it("passes a refusal through with its status", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "nope", code: 100 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await deleteTemplate(CFG, { name: "gone", hsmId: "1" })).toEqual({
      ok: false,
      status: 400,
      error: { error: { message: "nope", code: 100 } },
    });
  });
});
