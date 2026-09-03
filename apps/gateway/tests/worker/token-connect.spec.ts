import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import { GatewayRPC } from "../../src/rpc";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { SEALED_TOKEN_PREFIX } from "../../src/token-crypto";
import { SMB_APP_DATA_EDGE } from "../../src/meta/smb-app-data";
import { bootstrapAccount, TEST_ACCOUNT_ID } from "./helpers";

/**
 * `GatewayRPC.connectWabaWithToken` — attaching a WABA from a token an operator
 * pasted into the console (eccos-up9).
 *
 * The token here is a LIVE CREDENTIAL a human typed into a browser, so several
 * of these tests are about where it must not end up rather than about what the
 * method returns.
 */

/** Deliberately distinctive: several assertions search for it by substring. */
const PASTED_TOKEN = "EAAtestwabatoken0000000000pasted";

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/**
 * Meta with one own-app token that names `targetIds`, each WABA carrying one
 * phone. Returns the URL log so a test can assert what was NOT called.
 */
function mockGraph(targetIds: string[]): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/debug_token")) {
      return new Response(
        JSON.stringify({
          data: {
            app_id: "test-app-id",
            is_valid: true,
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: targetIds }],
          },
        }),
        { status: 200 },
      );
    }
    const waba = targetIds.find((id) => url.includes(`/${id}/phone_numbers`));
    if (waba) {
      return new Response(
        JSON.stringify({ data: [{ id: `PN_${waba}`, display_phone_number: `+3460000${waba}` }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  return urls;
}

function rpc(): GatewayRPC {
  return new GatewayRPC(createExecutionContext(), env);
}

describe("GatewayRPC.connectWabaWithToken", () => {
  it("registers the single WABA the token names and provisions it", async () => {
    await bootstrapAccount();
    mockGraph(["WABA_PASTE"]);

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);

    expect(result).toMatchObject({
      ok: true,
      waba_id: "WABA_PASTE",
      phone_number_id: "PN_WABA_PASTE",
      // eccos-lpk: the shared registration path provisions inside its budget,
      // so the console normally lands on an already-active number.
      status: "active",
    });
    await cp(async (instance) => {
      const stored = instance.sql
        .exec("SELECT meta_access_token FROM wabas WHERE waba_id = ?", "WABA_PASTE")
        .toArray()[0]?.meta_access_token as string | undefined;
      // INVARIANT: eccos-qke holds on THIS write path too — a pasted token is
      // sealed into the `ecs1.` AES-256-GCM envelope exactly like an Embedded
      // Signup one, because it goes through the same registration call.
      expect(stored).toContain(SEALED_TOKEN_PREFIX);
      expect(stored).not.toContain(PASTED_TOKEN);
    });
  });

  it("records a standard onboarding and initiates no coexistence sync", async () => {
    await bootstrapAccount();
    const urls = mockGraph(["WABA_STD"]);

    await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);

    // INVARIANT: a pasted token can never invent a coexistence obligation or
    // spend a once-only sync. There was no Embedded Signup handoff, so nothing
    // claims the number is on the WhatsApp Business app — and the two syncs
    // Meta allows exactly once each stay unspent.
    await cp(async (instance) => {
      const waba = await instance.getWaba(TEST_ACCOUNT_ID, "WABA_STD");
      expect(waba?.coexistence.onboardingType).toBe("standard");
      expect(waba?.coexistence.status).toBe("not_applicable");
      expect(waba?.coexistence.deadlineAt).toBeNull();
    });
    expect(urls.filter((url) => url.includes(SMB_APP_DATA_EDGE))).toHaveLength(0);
  });

  it("refuses to choose between several WABAs, and registers nothing", async () => {
    await bootstrapAccount();
    const urls = mockGraph(["WABA_ONE", "WABA_TWO"]);

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);

    // INVARIANT: ambiguity never auto-attaches. A system-user token can see
    // every WABA a business manages; registering them all on one paste would
    // mass-attach an agency's clients.
    expect(result).toMatchObject({
      ok: false,
      code: "multiple",
      candidates: [
        { wabaId: "WABA_ONE", phones: [{ phoneNumberId: "PN_WABA_ONE" }] },
        { wabaId: "WABA_TWO", phones: [{ phoneNumberId: "PN_WABA_TWO" }] },
      ],
    });
    expect(urls.filter((url) => url.includes("/subscribed_apps"))).toHaveLength(0);
    await cp(async (instance) => {
      expect(await instance.getWabaById("WABA_ONE")).toBeNull();
      expect(await instance.getWabaById("WABA_TWO")).toBeNull();
    });
  });

  it("registers only the chosen WABA when the resubmit names one", async () => {
    await bootstrapAccount();
    mockGraph(["WABA_ONE", "WABA_TWO"]);

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_TWO");

    // INVARIANT: the selector is the operator's answer to the question above —
    // it attaches that WABA and leaves the other one alone.
    expect(result).toMatchObject({ ok: true, waba_id: "WABA_TWO" });
    await cp(async (instance) => {
      expect(await instance.getWabaById("WABA_TWO")).not.toBeNull();
      expect(await instance.getWabaById("WABA_ONE")).toBeNull();
    });
  });

  it("cannot re-home a WABA another account already owns", async () => {
    await bootstrapAccount();
    await cp(async (instance) => {
      await instance.createAccount({ accountId: "other-account" });
      await instance.registerWaba({
        accountId: "other-account",
        wabaId: "WABA_FOREIGN",
        metaAccessToken: "their-token",
        callbackUrl: "https://gateway.example/webhooks/meta",
        provisioningStatus: "active",
        phones: [{ phoneNumberId: "PN_THEIRS" }],
      });
    });
    mockGraph(["WABA_FOREIGN"]);

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_FOREIGN");

    // INVARIANT: the token path cannot take another tenant's WABA. Holding a
    // token that can see a WABA is not ownership of it — the control plane is.
    expect(result).toMatchObject({ ok: false, code: "owned" });
    await cp(async (instance) => {
      const waba = await instance.getWabaById("WABA_FOREIGN");
      expect(waba?.accountId).toBe("other-account");
      // And their sealed token is untouched: nothing was overwritten.
      const stored = instance.sql
        .exec("SELECT meta_access_token FROM wabas WHERE waba_id = ?", "WABA_FOREIGN")
        .toArray()[0]?.meta_access_token as string | undefined;
      expect(stored).not.toContain(PASTED_TOKEN);
    });
  });

  it("stops at the foreign-app dead end without mutating anything", async () => {
    await bootstrapAccount();
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          error: {
            message: "The App_id in the input_token did not match the Viewing App",
            type: "OAuthException",
            code: 100,
          },
        }),
        { status: 400 },
      );
    });

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);

    // INVARIANT: nothing is mutated on the dead end, and the operator gets a
    // closed code the console has words for rather than Meta's sentence.
    expect(result).toEqual({ ok: false, code: "foreign_app", detail: null });
    expect(urls.filter((url) => url.includes("/subscribed_apps"))).toHaveLength(0);
    expect(urls.filter((url) => url.includes("/phone_numbers"))).toHaveLength(0);
  });

  it("throws on a malformed token before Meta is ever called", async () => {
    await bootstrapAccount();
    const urls = mockGraph(["WABA_PASTE"]);
    const api = rpc();

    // INVARIANT: defense in depth mirrors `exchangeConnectCodeForAccountId` —
    // the console validator is the strict one, so a shape reaching here is a
    // programmer error and belongs in the logs as a throw, not in the UI as a
    // failure code. And the message names the shape, never the value.
    await expect(api.connectWabaWithToken(TEST_ACCOUNT_ID, "   ")).rejects.toThrow(
      /token is required/,
    );
    await expect(api.connectWabaWithToken(TEST_ACCOUNT_ID, "short")).rejects.toThrow(
      /token is malformed/,
    );
    await expect(
      api.connectWabaWithToken(TEST_ACCOUNT_ID, `EAA has a space ${PASTED_TOKEN}`),
    ).rejects.toThrow(/token is malformed/);
    expect(urls).toHaveLength(0);
  });

  it("never returns the token, on success or on failure", async () => {
    await bootstrapAccount();
    mockGraph(["WABA_QUIET"]);
    const api = rpc();

    // INVARIANT: the credential goes in and only identifiers come back. This is
    // the assertion that fails if anyone ever "helpfully" echoes the token, a
    // prefix of it, or its length into the result.
    const ok = await api.connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);
    expect(JSON.stringify(ok)).not.toContain(PASTED_TOKEN);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Session has expired", code: 190 } }), {
        status: 400,
      }),
    );
    const failed = await api.connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);
    expect(failed).toEqual({ ok: false, code: "invalid_token", detail: null });
    expect(JSON.stringify(failed)).not.toContain(PASTED_TOKEN);
  });

  it("reports a token that names no WhatsApp account as no_waba", async () => {
    await bootstrapAccount();
    // Field-reported and real: `granular_scopes[].target_ids` is nullable, so a
    // valid own-app token can name no WABA at all. INVARIANT: that reads as
    // "this token points at nothing", not as an unexplained failure.
    mockGraph([]);
    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);
    expect(result).toEqual({ ok: false, code: "no_waba", detail: null });
  });
});
