import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { bootstrapAccount, TEST_ACCOUNT_ID, TEST_WABA_ID } from "./helpers";

/**
 * `createTemplate` / `deleteTemplate` — the console's authoring surface.
 *
 * Two invariants shape every test here. The RPC adds SCOPING and never reshapes
 * the request: what reaches Meta is the body the console described, plus the
 * WABA's own credentials. And ownership is the control plane's, always — a WABA
 * the account does not own fails closed before any credential is opened.
 */

beforeEach(async () => {
  await bootstrapAccount();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function makeRpc() {
  return new GatewayRPC(createExecutionContext(), env);
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    wabaId: TEST_WABA_ID,
    name: "order_update",
    language: "en_US",
    category: "UTILITY",
    bodyText: "Hi {{1}}, your order is on its way.",
    bodyExamples: ["Ada"],
    ...overrides,
  } as Parameters<GatewayRPC["createTemplate"]>[0];
}

/** A Graph mock that accepts any create with Meta's own success envelope. */
function mockCreateOk(category = "UTILITY") {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ id: "1234567890", status: "PENDING", category }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** A Graph mock that refuses with one of Meta's own error envelopes. */
function mockGraphError(
  error: { code?: number; error_subcode?: number; message?: string },
  status = 400,
) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: { type: "OAuthException", ...error } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("GatewayRPC.createTemplate", () => {
  it("passes the exact Graph body through and returns Meta's answer", async () => {
    // The RPC adds scoping, never reshaping: the WABA id and the bearer token
    // come from the registry, and everything else is what the console described.
    const fetchSpy = mockCreateOk();
    const result = await makeRpc().createTemplate(draft(), TEST_ACCOUNT_ID);
    expect(result).toEqual({
      ok: true,
      id: "1234567890",
      status: "PENDING",
      category: "UTILITY",
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(new RegExp(`/${TEST_WABA_ID}/message_templates$`));
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Hi {{1}}, your order is on its way.",
          example: { body_text: [["Ada"]] },
        },
      ],
    });
  });

  it("reports the category META assigned, not the one requested", async () => {
    // `allow_category_change` is now the default behaviour: Meta recategorises
    // on its own, and the console has to be able to say so.
    mockCreateOk("MARKETING");
    const result = await makeRpc().createTemplate(draft(), TEST_ACCOUNT_ID);
    expect(result).toMatchObject({ ok: true, category: "MARKETING" });
  });

  it("omits `example` for a zero-parameter body", async () => {
    const fetchSpy = mockCreateOk();
    await makeRpc().createTemplate(
      draft({ bodyText: "Welcome and congratulations!", bodyExamples: [] }),
      TEST_ACCOUNT_ID,
    );
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body.components[0]).not.toHaveProperty("example");
  });

  it("passes a footer and URL buttons through to the Graph body", async () => {
    // The RPC never reshapes what the console described: a footer becomes a
    // FOOTER component after the BODY, and the buttons become a BUTTONS
    // component with URL buttons in order — exampleUrls included for the
    // dynamic ones, omitted for static ones.
    const fetchSpy = mockCreateOk();
    await makeRpc().createTemplate(
      draft({
        footerText: "Powered by Eccos",
        buttons: [
          { text: "Track", url: "https://example.com/track" },
          {
            text: "Status",
            url: "https://example.com/status?t={{1}}",
            exampleUrl: "https://example.com/status?t=T-4",
          },
        ],
      }),
      TEST_ACCOUNT_ID,
    );
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body.components).toEqual([
      {
        type: "BODY",
        text: "Hi {{1}}, your order is on its way.",
        example: { body_text: [["Ada"]] },
      },
      { type: "FOOTER", text: "Powered by Eccos" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Track", url: "https://example.com/track" },
          {
            type: "URL",
            text: "Status",
            url: "https://example.com/status?t={{1}}",
            example: ["https://example.com/status?t=T-4"],
          },
        ],
      },
    ]);
  });

  it("fails closed for a WABA the account does not own, without calling Meta", async () => {
    // Tenant isolation: ownership is decided by the control plane before any
    // credential is opened.
    const fetchSpy = mockCreateOk();
    const error = await makeRpc()
      .createTemplate(draft(), "other-account")
      .then(() => null, (reason) => reason);
    expect(String(error?.message ?? error)).toMatch(/not owned|does not exist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("works on a WABA that has no active phone yet", async () => {
    // The `setSubscriberConfig` asymmetry, applied to authoring: creation is a
    // WABA-LEVEL write that needs only the WABA id and its stored token, and an
    // account still waiting for its number is exactly the one preparing its
    // templates. Authoring precedes provisioning.
    await runInDurableObject(getControlPlaneStub(env), async (cp) => {
      await cp.registerWaba({
        accountId: TEST_ACCOUNT_ID,
        wabaId: "WABA_PENDING",
        metaAccessToken: "pending-token",
        provisioningStatus: "pending",
        phones: [],
      });
    });
    const fetchSpy = mockCreateOk();
    const result = await makeRpc().createTemplate(
      draft({ wabaId: "WABA_PENDING" }),
      TEST_ACCOUNT_ID,
    );
    expect(result).toMatchObject({ ok: true, id: "1234567890" });
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/WABA_PENDING/);
  });

  it("maps Meta's codes to the closed vocabulary, subcode first", async () => {
    // Legible failures: the console renders per-code copy, so raw Graph JSON
    // never becomes the UI's contract. Meta reuses code 100 for every malformed
    // request, so only the SUBCODE separates "this name is taken" from "this
    // shape is wrong" — and an unmapped code degrades to `graph` carrying
    // Meta's own sentence.
    const cases = [
      { error: { code: 100, error_subcode: 2388024, message: "name exists" }, code: "name_taken", detail: "name exists" },
      { error: { code: 80008, message: "too many" }, code: "rate_limited", detail: "too many" },
      { error: { code: 100, message: "bad format" }, code: "invalid", detail: "bad format" },
      { error: { code: 999999, message: "meta says 999999" }, code: "graph", detail: "meta says 999999" },
    ] as const;

    for (const entry of cases) {
      vi.restoreAllMocks();
      mockGraphError({ ...entry.error });
      const result = await makeRpc().createTemplate(draft(), TEST_ACCOUNT_ID);
      expect(result, JSON.stringify(entry.error)).toEqual({
        ok: false,
        code: entry.code,
        detail: entry.detail,
      });
    }
  });

  it("falls back to the HTTP status when Meta sends no message text", async () => {
    mockGraphError({}, 502);
    expect(await makeRpc().createTemplate(draft(), TEST_ACCOUNT_ID)).toEqual({
      ok: false,
      code: "graph",
      detail: "HTTP 502",
    });
  });

  it("throws on malformed input, because only a regressed console can produce it", async () => {
    // Defense in depth: the dashboard validator is the strict one and the only
    // caller. Reaching any of these means that validator regressed, which is a
    // programmer error — a throw in the logs, not a failure code in the UI.
    const fetchSpy = mockCreateOk();
    for (const bad of [
      { name: "Order Update" },
      { language: "english" },
      { category: "AUTHENTICATION" },
      { bodyText: "" },
      { bodyText: "x".repeat(1025) },
      { bodyExamples: [""] },
      { bodyExamples: Array.from({ length: 31 }, () => "x") },
      { footerText: "" },
      { footerText: "x".repeat(61) },
      { footerText: "a one\na two" },
      { footerText: "Hi {{1}}" },
      { buttons: Array.from({ length: 4 }, () => ({ text: "x", url: "https://e.cc" })) },
      { buttons: [{ text: "", url: "https://e.cc" }] },
      { buttons: [{ text: "x", url: "ftp://e.cc" }] },
      { buttons: [{ text: "x", url: "https://e.cc/{{1}}" }] },
      { buttons: [{ text: "x", url: "https://e.cc/{{1}}", exampleUrl: "" }] },
    ]) {
      const error = await makeRpc()
        .createTemplate(draft(bad), TEST_ACCOUNT_ID)
        .then(() => null, (reason) => reason);
      expect(error, JSON.stringify(bad)).not.toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GatewayRPC.deleteTemplate", () => {
  it("deletes exactly one translation, by name AND hsm_id", async () => {
    // The name-only form of Meta's DELETE removes every language. The row the
    // operator clicked is one name+language pair, so this asserts the
    // per-translation form is what actually leaves.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await makeRpc().deleteTemplate(
      { wabaId: TEST_WABA_ID, name: "order_update", templateId: "1234567890" },
      TEST_ACCOUNT_ID,
    );
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("DELETE");
    const query = new URL(String(url)).searchParams;
    expect(query.get("name")).toBe("order_update");
    expect(query.get("hsm_id")).toBe("1234567890");
  });

  it("fails closed for a WABA the account does not own, and throws on a malformed id", async () => {
    const fetchSpy = mockCreateOk();
    const unowned = await makeRpc()
      .deleteTemplate(
        { wabaId: TEST_WABA_ID, name: "order_update", templateId: "1234567890" },
        "other-account",
      )
      .then(() => null, (reason) => reason);
    expect(String(unowned?.message ?? unowned)).toMatch(/not owned|does not exist/);

    const malformed = await makeRpc()
      .deleteTemplate(
        { wabaId: TEST_WABA_ID, name: "order_update", templateId: "not-an-id" },
        TEST_ACCOUNT_ID,
      )
      .then(() => null, (reason) => reason);
    expect(malformed).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a legible refusal rather than throwing when Meta says no", async () => {
    mockGraphError({ code: 100, message: "template not found" });
    expect(
      await makeRpc().deleteTemplate(
        { wabaId: TEST_WABA_ID, name: "order_update", templateId: "1234567890" },
        TEST_ACCOUNT_ID,
      ),
    ).toEqual({ ok: false, code: "graph", detail: "template not found" });
  });
});
