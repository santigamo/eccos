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

/**
 * Meta as the MEASURED System User token sees it: `debug_token` is valid,
 * own-app, with the WhatsApp scopes and NO `target_ids` (Meta returns it
 * nullable; `targetIds` restores it), and only the ids in `readable` answer
 * `phone_numbers` — any other id gets Graph's "does not exist / cannot be
 * loaded" refusal. `subscribeStatus` lets a test refuse `subscribed_apps`.
 */
function mockGraphSeed(opts: {
  targetIds?: string[];
  readable: Record<string, Array<{ id: string; display_phone_number?: string }>>;
  subscribeStatus?: number;
}): string[] {
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
            scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
            granular_scopes: opts.targetIds
              ? [{ scope: "whatsapp_business_management", target_ids: opts.targetIds }]
              : // The shape that motivated the whole change: the scopes are
                // there, the `target_ids` Meta documents as nullable are not.
                [
                  { scope: "whatsapp_business_management" },
                  { scope: "whatsapp_business_messaging" },
                ],
          },
        }),
        { status: 200 },
      );
    }
    const asked = Object.keys(opts.readable).find((id) => url.includes(`/${id}/phone_numbers`));
    if (url.includes("/phone_numbers")) {
      if (asked) return new Response(JSON.stringify({ data: opts.readable[asked] }), { status: 200 });
      const named = decodeURIComponent(url.split("/phone_numbers")[0]?.split("/").pop() ?? "");
      return new Response(
        JSON.stringify({
          error: {
            message: `Unsupported get request. Object with ID '${named}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
            type: "GraphMethodException",
            code: 100,
            error_subcode: 33,
          },
        }),
        { status: 400 },
      );
    }
    if (url.includes("/subscribed_apps")) {
      const status = opts.subscribeStatus ?? 200;
      return new Response(
        JSON.stringify(
          status === 200
            ? { success: true }
            : { error: { message: "(#200) Permissions error", type: "OAuthException", code: 200 } },
        ),
        { status },
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
    const urls = mockGraph(["WABA_ONE", "WABA_TWO"]);

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_TWO");

    // INVARIANT: the selector is the operator's answer to the question above —
    // it attaches that WABA and leaves the other one alone.
    expect(result).toMatchObject({ ok: true, waba_id: "WABA_TWO" });
    await cp(async (instance) => {
      expect(await instance.getWabaById("WABA_TWO")).not.toBeNull();
      expect(await instance.getWabaById("WABA_ONE")).toBeNull();
    });
    // The pick is a SEED, not a filter: the unchosen WABA is never even read,
    // so the resubmit costs one `phone_numbers` call instead of N.
    expect(urls.filter((url) => url.includes("/WABA_ONE/phone_numbers"))).toHaveLength(0);
  });

  it("a named WABA seeds discovery when the token names none (the measured system-user token)", async () => {
    await bootstrapAccount();
    // The bug this whole path exists for: a System User token that can read the
    // WABA fine, whose `debug_token` answer carries no `target_ids` at all.
    // Before the seed there was no way to attach an id known for days.
    const urls = mockGraphSeed({
      readable: { WABA_SEED: [{ id: "PN_SEED", display_phone_number: "+34600000001" }] },
    });

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_SEED");

    expect(result).toMatchObject({
      ok: true,
      waba_id: "WABA_SEED",
      phone_number_id: "PN_SEED",
      status: "active",
    });
    await cp(async (instance) => {
      const waba = await instance.getWaba(TEST_ACCOUNT_ID, "WABA_SEED");
      // Seeding changes what is discovered and NOTHING else: a pasted token
      // still cannot invent a coexistence obligation.
      expect(waba?.coexistence.onboardingType).toBe("standard");
      const stored = instance.sql
        .exec("SELECT meta_access_token FROM wabas WHERE waba_id = ?", "WABA_SEED")
        .toArray()[0]?.meta_access_token as string | undefined;
      expect(stored).toContain(SEALED_TOKEN_PREFIX);
      expect(stored).not.toContain(PASTED_TOKEN);
    });
    expect(urls.filter((url) => url.includes("/subscribed_apps"))).toHaveLength(1);
  });

  it("a named WABA is proven against Meta even when the token names others, and their discovery is skipped", async () => {
    await bootstrapAccount();
    const urls = mockGraphSeed({
      targetIds: ["WABA_A"],
      readable: {
        WABA_A: [{ id: "PN_A", display_phone_number: "+34600000002" }],
        WABA_SEED: [{ id: "PN_SEED", display_phone_number: "+34600000001" }],
      },
    });

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_SEED");

    // INVARIANT: `target_ids` is issuance-time metadata, not the authorization
    // check. A named WABA is proven against Meta directly, and a WABA the
    // token happens to also name is neither read nor registered.
    expect(result).toMatchObject({ ok: true, waba_id: "WABA_SEED" });
    await cp(async (instance) => {
      expect(await instance.getWabaById("WABA_A")).toBeNull();
    });
    expect(urls.filter((url) => url.includes("/WABA_A/phone_numbers"))).toHaveLength(0);
  });

  it("an unreadable named WABA is no_access — never owned — and registers nothing", async () => {
    await bootstrapAccount();
    const urls = mockGraphSeed({ readable: {} });

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_NOPE");

    // INVARIANT: Meta refusing the read is its OWN verdict. It used to come
    // back as `owned` — "belongs to another Eccos workspace" — which was
    // simply false, and sent the operator looking for a tenant conflict that
    // did not exist.
    expect(result).toMatchObject({ ok: false, code: "no_access" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).not.toBe("owned");
    expect(result.detail).toMatch(/^Unsupported get request/);
    expect(urls.filter((url) => url.includes("/subscribed_apps"))).toHaveLength(0);
    await cp(async (instance) => {
      expect(await instance.getWabaById("WABA_NOPE")).toBeNull();
    });
    expect(JSON.stringify(result)).not.toContain(PASTED_TOKEN);
  });

  it("a readable named WABA with no phone number is no_phone, and registers nothing", async () => {
    await bootstrapAccount();
    const urls = mockGraphSeed({ readable: { WABA_EMPTY: [] } });

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_EMPTY");

    // Meta let us read it and there is nothing to register — the same rule
    // discovery applies to an unnamed WABA. Its own code, so the console does
    // not re-ask for the id it was just given.
    expect(result).toEqual({ ok: false, code: "no_phone", detail: null });
    expect(urls.filter((url) => url.includes("/subscribed_apps"))).toHaveLength(0);
    await cp(async (instance) => {
      expect(await instance.getWabaById("WABA_EMPTY")).toBeNull();
    });
  });

  it("a named WABA another account owns fails closed with owned even when the token names nothing", async () => {
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
    mockGraphSeed({ readable: { WABA_FOREIGN: [{ id: "PN_THEIRS" }] } });

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_FOREIGN");

    // INVARIANT: seeding widens DISCOVERY, never ownership. The shared
    // registration path still asks the control plane who holds the WABA, and a
    // token that can read another tenant's account is still not ownership of it.
    expect(result).toMatchObject({ ok: false, code: "owned" });
    await cp(async (instance) => {
      const waba = await instance.getWabaById("WABA_FOREIGN");
      expect(waba?.accountId).toBe("other-account");
      const stored = instance.sql
        .exec("SELECT meta_access_token FROM wabas WHERE waba_id = ?", "WABA_FOREIGN")
        .toArray()[0]?.meta_access_token as string | undefined;
      expect(stored).not.toContain(PASTED_TOKEN);
    });
  });

  it("a named WABA the token can read but cannot subscribe registers as failed, never active", async () => {
    await bootstrapAccount();
    mockGraphSeed({
      readable: { WABA_NOSUB: [{ id: "PN_NOSUB" }] },
      subscribeStatus: 403,
    });

    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_NOSUB");

    // INVARIANT: a token that reads the WABA but cannot subscribe the app to it
    // fails CLOSED. Meta's 4xx on `subscribed_apps` is non-retryable, so the
    // row lands terminally `failed` — no phone ever becomes active, the send
    // path refuses a non-active WABA — and the operator fixes the asset grant
    // and presses Re-check rather than re-pasting the credential.
    expect(result).toMatchObject({ ok: true, waba_id: "WABA_NOSUB", status: "failed" });
    await cp(async (instance) => {
      // `getWabaRecord`, not `getWaba`: the latter resolves a non-active row to
      // null *by design*, which is the fail-closed rule itself — asserted right
      // below, because "the send path cannot see this WABA" is the property
      // that matters more than the label on the row.
      const waba = await instance.getWabaRecord(TEST_ACCOUNT_ID, "WABA_NOSUB");
      expect(waba?.status).toBe("failed");
      expect(waba?.provisioningError).toMatch(/subscribed_apps failed with HTTP 403/);
      expect(await instance.getWaba(TEST_ACCOUNT_ID, "WABA_NOSUB")).toBeNull();
      const stored = instance.sql
        .exec("SELECT meta_access_token FROM wabas WHERE waba_id = ?", "WABA_NOSUB")
        .toArray()[0]?.meta_access_token as string | undefined;
      expect(stored).toContain(SEALED_TOKEN_PREFIX);
      expect(stored).not.toContain(PASTED_TOKEN);
    });
  });

  it("throws on a malformed WABA id before Meta is ever called", async () => {
    await bootstrapAccount();
    const urls = mockGraph(["WABA_PASTE"]);
    const api = rpc();

    // Defense in depth, the same rule as the token: the console validator is
    // the strict one (digits only), this is the mirrored throw, and the message
    // names the SHAPE, never the value.
    await expect(
      api.connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "not a waba id!"),
    ).rejects.toThrow(/wabaId is malformed/);
    await expect(
      api.connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "x".repeat(65)),
    ).rejects.toThrow(/wabaId is malformed/);
    expect(urls).toHaveLength(0);
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

    // And the third shape, the one that carries Meta's own sentence back: a
    // `detail` is a place a token could be echoed, so it is checked too.
    vi.restoreAllMocks();
    mockGraphSeed({ readable: {} });
    const refused = await api.connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN, "WABA_NOPE");
    expect(refused).toMatchObject({ ok: false, code: "no_access" });
    expect(JSON.stringify(refused)).not.toContain(PASTED_TOKEN);
  });

  it("answers no_waba only when nothing was named, and reads nothing", async () => {
    await bootstrapAccount();
    // Measured, not hypothetical: `granular_scopes[].target_ids` is nullable and
    // a valid own-app System User token comes back without it. INVARIANT:
    // `no_waba` is now a QUESTION the console answers with the id field, and it
    // is returned ONLY when no id was named — so it can never loop that
    // question. Nothing is read, because there is nothing to read.
    const urls = mockGraphSeed({ readable: {} });
    const result = await rpc().connectWabaWithToken(TEST_ACCOUNT_ID, PASTED_TOKEN);
    expect(result).toEqual({ ok: false, code: "no_waba", detail: null });
    expect(urls.filter((url) => url.includes("/phone_numbers"))).toHaveLength(0);
  });
});
