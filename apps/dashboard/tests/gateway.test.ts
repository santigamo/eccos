import { afterEach, describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { UnauthorizedError } from "../src/auth/session";

/**
 * Server/data-layer coverage for every operator view (finding F11: the
 * product-UI gate had zero automated verification beyond the isolated Access
 * unit test).
 *
 * `src/server/gateway.ts` does two things that make it impossible to import
 * directly under a plain `bun test` process:
 *
 *  1. `import { env } from "cloudflare:workers"` — a virtual module that only
 *     exists inside the Cloudflare Workers runtime (workerd) or under
 *     `@cloudflare/vitest-pool-workers`. Plain Bun has no such module.
 *  2. `import { createServerFn } from "@tanstack/react-start"` — whose real
 *     implementation resolves package.json `exports` conditions
 *     (`@tanstack/router-core/isServer` etc.) that are only satisfied by the
 *     Vite build. Under plain `bun run`/`bun test` (no Vite resolver) this
 *     throws `Cannot find module '@tanstack/router-core/isServer'` at import
 *     time — confirmed by hand before writing this file.
 *
 * Both are mocked here, via `bun:test`'s built-in `mock.module`, BEFORE
 * dynamically importing the real `src/server/gateway.ts`. `mock.module`
 * intercepts the module specifier at resolution time, so the real
 * `cloudflare:workers` / `@tanstack/react-start` packages are never touched —
 * only the module *under test* (`../src/server/gateway`) is real. This adds
 * zero new dependencies (no jsdom, no test-only Workers runtime, no
 * `vitest-pool-workers` in this Bun-run suite) and still exercises the actual
 * `withGateway` reachable / unreachable / thrown-error logic that every view
 * depends on for its graceful "Gateway unreachable" state.
 *
 * The runtime shims come from `./helpers/server-fn-mocks`, which every test in
 * this suite shares. That fake DOES run `.validator()`, so the assertions here
 * exercise the same input path production does. It is shared rather than
 * declared inline because bun bakes a src module's top-level
 * `createServerFn(...)` chains from whichever fake is live the first time that
 * module evaluates — which file that is depends on bun's directory-walk order —
 * so eight copies that disagreed made this suite pass alone and fail in a full
 * run. The helper's header carries the full mechanism.
 */

let gatewayBinding: Record<string, (...args: unknown[]) => unknown> | undefined;
const workerEnv: {
  BETTER_AUTH_URL?: string;
  readonly GATEWAY?: typeof gatewayBinding;
} = {
  get GATEWAY() {
    return gatewayBinding;
  },
};

workerEnv.BETTER_AUTH_URL = "http://localhost:3000";

// Mutable fake session for the auth layer. `null` = unauthenticated (the
// default): server functions must fail closed. A test that exercises the
// authenticated path sets `fakeSessionHeaders` to a Headers object with a
// (notional) session cookie; the mocked auth API accepts it as a member with
// every gateway permission and links the org to the fixture account.
let fakeSessionHeaders: Headers | null = null;
let fakeMemberships: { id: string; name?: string }[] = [{ id: "org-fixture" }];
/** Gateway actions the fake role does NOT hold, to drive the forbidden path. */
let fakeDeniedActions = new Set<string>();


const ORG_ID = "org-fixture";
    // Mock the auth seam (not the real session/tenant modules, which other test
    // files exercise) so the data-plane tests do not spin up Better Auth. The
    // seam receives (auth, request) — both ignored under the mock.
    // Capture the REAL tenant module through a query-string specifier (a distinct
// module id the mock registry below does not intercept) so its exports can be
// re-published from the sync mock factory. This lets gateway.ts receive the
// mocked resolveMemberships while permissions.test.ts (same bun process) keeps
// working against the real requirePermission/verifyMembership/ForbiddenError.
const realTenant = await import("../src/auth/tenant?real-module");
mock.module("../src/auth/tenant", () => ({
  ...realTenant,
  resolveMemberships: async () => fakeMemberships,
}));

// The seam throws the SAME typed errors the real guards do — the boundary in
// gateway.ts classifies by the error's type, so a mock that threw a bare Error
// would silently exercise the wrong branch (eccos-k5a). `ForbiddenError` comes
// from `realTenant` because that is the very class the mocked `../auth/tenant`
// re-publishes, and therefore the one gateway.ts holds.
const { ForbiddenError } = realTenant;
// THIS REGISTRATION OUTLIVES THIS FILE. Bun's module registry is process-global
// and never resets between test files, so any later-running test that imports
// `../src/auth/server-auth` gets THIS mock, not the real module. A test that
// needs the real one must import it through the `?real-module` query specifier
// — `tests/request-memo.test.ts` does exactly that, and says why.
mock.module("../src/auth/server-auth", () => ({
      UnauthorizedError,
      // Mirrors the real requirePermission's fail-closed ladder: no session,
      // no membership, ambiguous membership, then the capability check.
      requireGatewayPermission: async (_auth: unknown, _request: Request, action: string) => {
        if (!fakeSessionHeaders) throw new UnauthorizedError();
        if (fakeMemberships.length === 0) {
          throw new ForbiddenError(
            "no organization membership — create or join an organization first",
            "no-organization",
          );
        }
        if (fakeMemberships.length > 1) {
          throw new ForbiddenError("select an organization", "select-organization");
        }
        if (fakeDeniedActions.has(action)) {
          throw new ForbiddenError(
            `missing "${action}" permission in this organization`,
            "missing-permission",
          );
        }
        return ORG_ID;
      },
      resolveMemberships: async () => fakeMemberships,
      requireAuthContext: async (_auth: unknown, _request: Request) => {
        if (!fakeSessionHeaders) throw new UnauthorizedError();
        return { session: { userId: "user-1", email: "op@corp.test", emailVerified: true, name: "Op", sessionId: "sess-1", activeOrganizationId: null } };
      },
    }));

installServerFnMocks({
  env: workerEnv,
  // The server-function request carries the current fake session's headers
  // (or none). Read at call time, so this stays correct per test.
  getRequest: () => {
    const headers = new Headers();
    if (fakeSessionHeaders) {
      for (const [k, v] of fakeSessionHeaders.entries()) headers.set(k, v);
    }
    return new Request("http://localhost:3000/", { headers });
  },
});

const {
  getGatewayStatus,
  getDashboardOverview,
  getDashboardState,
  startConnect,
  listDeliveries,
  listInbound,
  listOutbound,
  listTemplates,
  retryDelivery,
  getSubscriberConfig,
  setSubscriberConfig,
  resubscribe,
  recheckNumber,
  sendTemplateTest,
  validateSendTestInput,
  createTemplate,
  deleteTemplate,
  validateCreateTemplateInput,
  validateDeleteTemplateInput,
  connectWithToken,
  validateTokenConnectInput,
} = await import("../src/server/gateway");

afterEach(() => {
  gatewayBinding = undefined;
  fakeSessionHeaders = null;
  fakeMemberships = [{ id: "org-fixture" }];
  fakeDeniedActions = new Set();
});

const UNCONFIGURED_ERROR = "GATEWAY service binding is not configured";

/**
 * A transport / RPC failure, as the boundary reports it (eccos-k5a). Only this
 * class is allowed to blame the gateway, so every "unreachable" expectation
 * below asserts the class as well as the message.
 */
function unreachable(error: string) {
  return { ok: false, kind: "unreachable", error };
}

/**
 * One WABA as the contract declares it — `status` included.
 *
 * The fixtures used to omit `status` entirely, which quietly made every
 * status-aware assertion in this file vacuous: a WABA that is neither active
 * nor pending exists nowhere but here.
 */
function wabaFixture(
  accountId: string,
  wabaId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    accountId,
    wabaId,
    callbackUrl: null,
    createdAt: 1,
    provisionedAt: 1,
    status: "active",
    provisioningError: null,
    phones: [],
    coexistence: {
      onboardingType: "standard",
      verifiedOnboardingType: "standard",
      status: "not_applicable",
      deadlineAt: null,
      contactsStartedAt: null,
      contactsRequestId: null,
      historyStartedAt: null,
      historyRequestId: null,
      error: null,
    },
    ...overrides,
  };
}

/** Account resources fixture with an owned WABA, for every account-scoped view. */
function resourcesFor(accountId: string) {
  return {
    account: { accountId, name: "Account A", createdAt: 1 },
    keys: [],
    wabas: [
      wabaFixture(accountId, "waba-a", {
        phones: [{ phoneNumberId: "phone-a", displayPhoneNumber: "+1" }],
      }),
    ],
    phones: [{ wabaId: "waba-a", phoneNumberId: "phone-a", displayPhoneNumber: "+1" }],
  };
}

function withResources(binding: typeof gatewayBinding, options: { accountId?: string } = {}) {
  const accountId = options.accountId ?? "account-a";
  fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
  gatewayBinding = {
    getOrganizationAccountLink: async (organizationId: string) =>
      organizationId === ORG_ID && fakeSessionHeaders ? { accountId, status: "active" } : null,
    ensureOrganizationAccount: async (organizationId: string) => {
      if (organizationId !== ORG_ID || !fakeSessionHeaders) {
        throw new Error("not a member of the requested organization");
      }
      return { accountId, status: "active" as const };
    },
    listAccountResources: async () => resourcesFor(accountId),
    ...binding,
  };
}

describe("getGatewayStatus (Status view)", () => {
  test("reachable: returns the gateway's status payload", async () => {
    withResources({
      getStatus: async () => ({
        name: "eccos",
        version: "1.2.3",
        health: "healthy",
        connection: {
          wabaId: "waba-a",
          phoneNumberId: "phone-1",
          displayPhone: "+1 555",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
        counts: { inbound: 3, outbound: { sent: 2 }, deliveries: { delivered: 2 } },
      }),
    });
    const res = await getGatewayStatus();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status.health).toBe("healthy");
      expect(res.status.connection.wabaId).toBe("waba-a");
    }
  });

  test("unreachable: missing GATEWAY binding yields the graceful error shape", async () => {
    withResources({});
    gatewayBinding = undefined;
    const res = await getGatewayStatus();
    expect(res).toEqual(unreachable(UNCONFIGURED_ERROR));
  });

  test("unreachable: RPC throw is caught and surfaced as { ok: false }", async () => {
    withResources({
      getStatus: async () => {
        throw new Error("Durable Object unreachable");
      },
    });
    const res = await getGatewayStatus();
    expect(res).toEqual(unreachable("Durable Object unreachable"));
  });

  test("account mode resolves an owned WABA and forwards the account context", async () => {
    const statusArgs: unknown[] = [];
    withResources({
      listAccountResources: async (accountId: string) => ({
        account: { accountId, name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [
          wabaFixture(accountId, "waba-z"),
          wabaFixture(accountId, "waba-a", {
            phones: [{ phoneNumberId: "phone-a", displayPhoneNumber: "+1" }],
          }),
        ],
        phones: [{ wabaId: "waba-a", phoneNumberId: "phone-a", displayPhoneNumber: "+1" }],
      }),
      getStatus: async (...args: unknown[]) => {
        statusArgs.push(...args);
        return {
          name: "eccos",
          version: "1.2.3",
          health: "healthy",
          connection: { wabaId: "waba-a", phoneNumberId: "phone-a", displayPhone: "+1", connectedAt: null },
          counts: { inbound: 0, outbound: {}, deliveries: {} },
        };
      },
    });
    const overview = await getDashboardOverview();
    expect(overview.ok).toBe(true);
    if (overview.ok) {
      expect(overview.data.scope).toMatchObject({ accountId: "account-a", selectedWabaId: "waba-a" });
      expect(overview.data.scope.resources.wabas[1]?.wabaId).toBe("waba-z");
    }
    expect(statusArgs).toEqual(["waba-a", "account-a"]);
  });

  test("account mode accepts an owned WABA and falls back from an unowned one", async () => {
    const statusArgs: unknown[] = [];
    withResources({
      listAccountResources: async () => ({
        account: { accountId: "account-a", name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [
          wabaFixture("account-a", "waba-a"),
          wabaFixture("account-a", "waba-b"),
        ],
        phones: [],
      }),
      getStatus: async (...args: unknown[]) => {
        statusArgs.push(...args);
        return {
          name: "eccos",
          version: "1.2.3",
          health: "healthy",
          connection: { wabaId: "waba-b", phoneNumberId: null, displayPhone: null, connectedAt: null },
          counts: { inbound: 0, outbound: {}, deliveries: {} },
        };
      },
    });

    const selected = await getDashboardOverview({ data: { wabaId: "waba-b" } });
    expect(selected.ok).toBe(true);
    expect(statusArgs).toEqual(["waba-b", "account-a"]);

    const foreign = await getDashboardOverview({ data: { wabaId: "waba-foreign" } });
    expect(foreign.ok).toBe(true);
    if (foreign.ok) {
      expect(foreign.data.scope.selectedWabaId).toBe("waba-a");
    }
    expect(statusArgs).toEqual(["waba-b", "account-a", "waba-a", "account-a"]);

    const mutation = await retryDelivery({ data: { id: 1, wabaId: "waba-foreign" } });
    expect(mutation).toEqual(unreachable('WABA "waba-foreign" is not owned by account "account-a"'));
  });

  test("fails closed when the account has no registered WABAs", async () => {
    fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
    gatewayBinding = {
      getOrganizationAccountLink: async () => ({ accountId: "account-a", status: "active" }),
      listAccountResources: async () => ({
        account: { accountId: "account-a", name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [],
        phones: [],
      }),
    };
    const res = await getGatewayStatus();
    expect(res).toEqual(unreachable('Account "account-a" has no registered WABAs'));
  });
});

describe("session bootstrap (auth-aware state)", () => {
  test("unauthenticated requests fail closed before any RPC", async () => {
    let rpcTouched = false;
    gatewayBinding = {
      getOrganizationAccountLink: async () => {
        rpcTouched = true;
        return null;
      },
    };
    const result = await getDashboardState();
    // Classified as a lost session, NOT as a dead gateway: no RPC was tried.
    expect(result).toEqual({
      ok: false,
      kind: "unauthenticated",
      error: "authentication required",
    });
    expect(rpcTouched).toBe(false);
  });

  test("first-run: zero memberships returns no-organization without touching the gateway", async () => {
    fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
    fakeMemberships = [];
    let rpcTouched = false;
    gatewayBinding = {
      getOrganizationAccountLink: async () => {
        rpcTouched = true;
        return null;
      },
    };
    const result = await getDashboardState();
    expect(result).toEqual({ ok: true, data: { stage: "no-organization" } });
    expect(rpcTouched).toBe(false);
  });

  test("reports an account with no WABA as setup-ready", async () => {
    fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
    gatewayBinding = {
      getOrganizationAccountLink: async () => ({ accountId: "account-a", status: "active" }),
      listAccountResources: async () => ({
        account: { accountId: "account-a", name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [],
        phones: [],
      }),
    };
    const result = await getDashboardState();
    expect(result).toEqual({
      ok: true,
      data: { stage: "account-ready", resources: {
        account: { accountId: "account-a", name: "Account A", createdAt: 1 },
        keys: [], wabas: [], phones: [],
      } },
    });
  });

  test("an account whose only WABA is awaiting a phone number stays inside the app", async () => {
    // THE BUG THIS GUARDS. A WABA in the awaiting-a-phone limbo stays `pending`,
    // and resolving a scope for it throws — which the boundary classifies as
    // `unreachable`. The customer then met "Gateway unreachable" on every page
    // INCLUDING /numbers, the one page whose note explains exactly this state.
    // The console must never blame its own transport for a customer's missing
    // phone number.
    fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
    withResources({
      listAccountResources: async () => ({
        account: { accountId: "account-a", name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [
          wabaFixture("account-a", "waba-a", {
            status: "pending",
            provisionedAt: null,
            provisioningError:
              "connected, but this WhatsApp Business account has no business phone number yet; add one in WhatsApp Manager and Eccos will pick it up",
          }),
        ],
        phones: [],
      }),
    });
    const result = await getDashboardState();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stage).toBe("account-ready");
    if (result.data.stage !== "account-ready") return;
    // The resources travel with the stage, because /numbers renders the note
    // from them.
    expect(result.data.resources.wabas[0]?.status).toBe("pending");
  });

  test("one active and one pending WABA resolves to the active one", async () => {
    // Default selection used to be `wabas[0]` by id sort, so a pending WABA
    // sorting first broke a tenant that was working perfectly well.
    fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
    const statusArgs: unknown[] = [];
    withResources({
      listAccountResources: async () => ({
        account: { accountId: "account-a", name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [
          wabaFixture("account-a", "waba-z", {
            phones: [{ phoneNumberId: "phone-z", displayPhoneNumber: "+1" }],
          }),
          wabaFixture("account-a", "waba-a", { status: "pending", provisionedAt: null }),
        ],
        phones: [{ wabaId: "waba-z", phoneNumberId: "phone-z", displayPhoneNumber: "+1" }],
      }),
      getStatus: async (...args: unknown[]) => {
        statusArgs.push(...args);
        return {
          name: "eccos",
          version: "1.2.3",
          health: "healthy",
          connection: { wabaId: "waba-z", phoneNumberId: "phone-z", displayPhone: "+1", connectedAt: null },
          counts: { inbound: 0, outbound: {}, deliveries: {} },
        };
      },
    });
    const result = await getDashboardState();
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.stage !== "ready") throw new Error("expected a ready stage");
    expect(result.data.scope.selectedWabaId).toBe("waba-z");
    expect(statusArgs).toEqual(["waba-z", "account-a"]);
  });

  test("starts Embedded Signup through the resolved account id", async () => {
    const calls: unknown[][] = [];
    withResources({
      startConnectForAccountId: async (...args: unknown[]) => {
        calls.push(args);
        return { url: "https://gateway.example/connect?state=one-time", state: "one-time", expiresAt: 2 };
      },
    });
    const result = await startConnect();
    expect(result).toEqual({
      ok: true,
      data: { url: "https://gateway.example/connect?state=one-time", state: "one-time", expiresAt: 2 },
    });
    // eccos-5z9: the gateway owns Meta's callback, so it needs somewhere to send
    // the operator back to. The target is built from the request origin, which
    // the server entry has already narrowed to the canonical host — never from
    // anything the browser supplies.
    expect(calls).toEqual([["account-a", "http://localhost:3000/numbers"]]);
  });
});

// --- Deliveries view (routes/deliveries.tsx) ---

describe("listDeliveries / retryDelivery (Deliveries view)", () => {
  test("reachable: forwards filter options and returns rows", async () => {
    const receivedOpts: unknown[] = [];
    withResources({
      listDeliveries: async (opts: unknown) => {
        receivedOpts.push(opts);
        return [{ id: 1, status: "failed", attempts: 2, last_error: "timeout", next_attempt_at: 0, created_at: 0, payload: "{}" }];
      },
    });
    const res = await listDeliveries({ data: { status: "failed", before: 100 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0]?.status).toBe("failed");
    expect(receivedOpts).toEqual([{ status: "failed", before: 100, wabaId: "waba-a" }]);
  });

  test("unreachable: throw is surfaced as { ok: false }", async () => {
    withResources({
      listDeliveries: async () => {
        throw new Error("network error");
      },
    });
    const res = await listDeliveries({ data: undefined });
    expect(res).toEqual(unreachable("network error"));
  });

  test("retryDelivery reachable: requires and forwards the selected WABA scope", async () => {
    const retryArgs: unknown[] = [];
    withResources({
      retryDelivery: async (...args: unknown[]) => {
        retryArgs.push(...args);
        const id = args[0] as number;
        return { ok: true, previousStatus: id === 7 ? "failed" : null };
      },
    });
    const res = await retryDelivery({ data: { id: 7, wabaId: "waba-a" } });
    expect(res).toEqual({ ok: true, data: { ok: true, previousStatus: "failed" } });
    expect(retryArgs).toEqual([7, "waba-a", "account-a"]);
  });

  test("retryDelivery unreachable: missing binding yields the graceful error shape", async () => {
    withResources({});
    gatewayBinding = undefined;
    const res = await retryDelivery({ data: { id: 7, wabaId: "waba-a" } });
    expect(res).toEqual(unreachable(UNCONFIGURED_ERROR));
  });
});

// --- Inbound view (routes/inbound.tsx) ---

describe("listInbound (Inbound view)", () => {
  test("reachable: returns inbound rows", async () => {
    withResources({
      listInbound: async () => [
        { id: 1, type: "message", transport_message_id: "wamid.1", message_id: null, payload: "{}", received_at: 0 },
      ],
    });
    const res = await listInbound();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(1);
  });

  test("unreachable: throw is surfaced as { ok: false }", async () => {
    withResources({
      listInbound: async () => {
        throw new Error("boom");
      },
    });
    const res = await listInbound();
    expect(res).toEqual(unreachable("boom"));
  });
});

// --- Outbound view (routes/outbound.tsx) ---

describe("listOutbound (Outbound view)", () => {
  test("reachable: returns outbound rows", async () => {
    withResources({
      listOutbound: async () => [
        { id: 1, transport_message_id: "wamid.1", recipient: "+1", request: "{}", status: "sent", error: null, created_at: 0 },
      ],
    });
    const res = await listOutbound();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0]?.status).toBe("sent");
  });

  test("unreachable: missing binding yields the graceful error shape", async () => {
    withResources({});
    gatewayBinding = undefined;
    const res = await listOutbound();
    expect(res).toEqual(unreachable(UNCONFIGURED_ERROR));
  });
});

// --- Templates view (routes/templates.tsx) — has a second, inner ok/error layer ---

describe("listTemplates (Templates view)", () => {
  test("reachable + Meta fetch ok: returns the inner templates payload", async () => {
    withResources({
      listTemplates: async () => ({ ok: true, data: { data: [{ name: "hello_world", language: "en_US", status: "approved" }] } }),
    });
    const res = await listTemplates();
    expect(res.ok).toBe(true);
    if (res.ok && res.data.ok) {
      const inner = res.data.data as { data: Array<{ name: string }> };
      expect(inner.data[0]?.name).toBe("hello_world");
    }
  });

  test("reachable but Meta rejected: inner { ok: false } is preserved", async () => {
    withResources({
      listTemplates: async () => ({ ok: false, error: "Meta API error" }),
    });
    const res = await listTemplates();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ ok: false, error: "Meta API error" });
  });

  test("unreachable: throw is surfaced as the outer { ok: false }", async () => {
    withResources({
      listTemplates: async () => {
        throw new Error("RPC unreachable");
      },
    });
    const res = await listTemplates();
    expect(res).toEqual(unreachable("RPC unreachable"));
  });

  test("a WABA still awaiting its phone number can still list its templates", async () => {
    // The deliberate asymmetry: a template list needs the WABA id and its
    // stored Meta token, nothing from the per-WABA data plane. The data plane
    // stays closed in the same state — asserted below — because there is
    // genuinely nothing there to read.
    const limbo = {
      listAccountResources: async () => ({
        account: { accountId: "account-a", name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [wabaFixture("account-a", "waba-a", { status: "pending", provisionedAt: null })],
        phones: [],
      }),
    };
    let statusCalled = false;
    withResources({
      ...limbo,
      listTemplates: async () => ({ ok: true, data: { data: [] } }),
      getStatus: async () => {
        statusCalled = true;
        throw new Error("should never be reached");
      },
    });
    expect(await listTemplates()).toEqual({ ok: true, data: { ok: true, data: { data: [] } } });

    const status = await getGatewayStatus();
    expect(status).toEqual(unreachable('WABA "waba-a" is still provisioning'));
    expect(statusCalled).toBe(false);
  });
});

// --- Send test (routes/templates.tsx + components/templates/send-test-sheet.tsx) ---

describe("sendTemplateTest (Send test sheet)", () => {
  const SEND = {
    wabaId: "waba-a",
    phoneNumberId: "phone-a",
    to: "34600000011",
    templateName: "hello_world",
    languageCode: "en_US",
  };

  test("forwards the validated input and the resolved accountId to the binding", async () => {
    const calls: unknown[][] = [];
    withResources({
      sendTemplateTest: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true, messageId: "wamid.SENT" };
      },
    });
    const res = await sendTemplateTest({ data: { ...SEND, bodyParams: ["Ada"] } });
    expect(res).toEqual({ ok: true, data: { ok: true, messageId: "wamid.SENT" } });
    expect(calls).toEqual([[{ ...SEND, bodyParams: ["Ada"] }, "account-a"]]);
  });

  /**
   * TRIPWIRE for the shared server-fn fake. Do not delete; do not weaken.
   *
   * The invariant: the suite's `createServerFn` fake RUNS `.validator()`, so
   * this asserts normalization THROUGH the route rather than by calling the
   * validator directly. It fails if any earlier-evaluating test file ever bakes
   * `src/server/gateway.ts` with a fake that skips validation — which is
   * exactly the regression that once made this file pass alone and fail in a
   * full run. If it goes red, fix `./helpers/server-fn-mocks`, not this test.
   */
  test("the route itself normalizes the recipient (shared fake runs validators)", async () => {
    const calls: unknown[][] = [];
    withResources({
      sendTemplateTest: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true, messageId: "wamid.SENT" };
      },
    });
    await sendTemplateTest({ data: { ...SEND, to: "+34 600-00-00-11" } });
    expect((calls[0]?.[0] as { to: string }).to).toBe("34600000011");
  });

  test("normalizes a human-typed recipient to digits before it leaves the console", () => {
    // Operators paste "+34 600-00-00-11". The Cloud API takes digits only, and
    // the normalization belongs on the server boundary rather than in the
    // sheet, because the boundary is the one that cannot be bypassed.
    expect(validateSendTestInput({ ...SEND, to: "+34 600-00-00-11" })).toEqual(SEND);
    expect(validateSendTestInput({ ...SEND, to: "(600) 000-011" }).to).toBe("600000011");
  });

  test("refuses everything the gateway must never be asked to send", () => {
    // The gateway re-checks these shapes and THROWS on them, so a regression
    // here would surface as a server error rather than a message an operator
    // can act on. Each case is a sentence the sheet can show instead.
    expect(() => validateSendTestInput({ ...SEND, to: "call-me" })).toThrow(/recipient/);
    expect(() => validateSendTestInput({ ...SEND, bodyParams: ["line one\nline two"] })).toThrow(
      /line breaks/,
    );
    expect(() => validateSendTestInput({ ...SEND, bodyParams: ["  "] })).toThrow(/needs a value/);
    expect(() => validateSendTestInput({ ...SEND, templateName: "Hello World" })).toThrow(
      /template name/,
    );
    expect(() => validateSendTestInput({ ...SEND, languageCode: "english" })).toThrow(/language/);
    // A test send must never silently fall back to the account's first WABA or
    // its first number: which number the message leaves from IS the exercise.
    expect(() => validateSendTestInput({ ...SEND, wabaId: undefined })).toThrow(/wabaId/);
    expect(() => validateSendTestInput({ ...SEND, phoneNumberId: "" })).toThrow(/phoneNumberId/);
  });

  test("requires operate: a role without it is refused and the binding is never touched", async () => {
    let called = false;
    withResources({
      sendTemplateTest: async () => {
        called = true;
        return { ok: true, messageId: "wamid.SENT" };
      },
    });
    fakeDeniedActions = new Set(["operate"]);
    const res = await sendTemplateTest({ data: SEND });
    expect(res).toMatchObject({ ok: false, kind: "forbidden", reason: "missing-permission" });
    expect(called).toBe(false);
  });

  test("fails closed without a session", async () => {
    let called = false;
    withResources({
      sendTemplateTest: async () => {
        called = true;
        return { ok: true, messageId: "wamid.SENT" };
      },
    });
    fakeSessionHeaders = null;
    const res = await sendTemplateTest({ data: SEND });
    expect(res).toMatchObject({ ok: false, kind: "unauthenticated" });
    expect(called).toBe(false);
  });

  test("a WABA the account does not own is refused before the send", async () => {
    // rejectUnknown: a test send must never silently fall back to the account's
    // first WABA — which number the message leaves from IS the exercise.
    let called = false;
    withResources({
      sendTemplateTest: async () => {
        called = true;
        return { ok: true, messageId: "wamid.SENT" };
      },
    });
    const res = await sendTemplateTest({ data: { ...SEND, wabaId: "waba-foreign" } });
    expect(res).toMatchObject({ ok: false, kind: "unreachable" });
    expect(called).toBe(false);
  });

  test("a refused send comes back as the typed inner failure, not a thrown error", async () => {
    withResources({
      sendTemplateTest: async () => ({
        ok: false,
        code: "recipient_not_allowlisted",
        detail: "Recipient phone number not in allowed list",
      }),
    });
    const res = await sendTemplateTest({ data: SEND });
    expect(res).toEqual({
      ok: true,
      data: {
        ok: false,
        code: "recipient_not_allowlisted",
        detail: "Recipient phone number not in allowed list",
      },
    });
  });

  test("the audit record carries NO recipient and NO parameter value", async () => {
    // THIS TEST EXISTS TO FAIL the moment someone "helpfully" adds the
    // recipient to the audit line. Audit logs are not per-phone erasable, so a
    // number here would silently break GDPR erasure completeness — while the
    // full recipient already lives in the data-plane outbound_messages row,
    // which retention and eraseByPhone do govern.
    withResources({ sendTemplateTest: async () => ({ ok: true, messageId: "wamid.SENT" }) });
    const emitted: string[] = [];
    const original = console.info;
    console.info = (line: string) => {
      emitted.push(String(line));
    };
    try {
      await sendTemplateTest({
        data: { ...SEND, to: "+34 600-00-00-11", bodyParams: ["Ada Lovelace"] },
      });
    } finally {
      console.info = original;
    }
    const audit = emitted.find((line) => line.includes('"area":"audit"'));
    expect(audit).toBeDefined();
    expect(audit).toContain('"action":"template_test_send"');
    expect(audit).toContain('"messageId":"wamid.SENT"');
    expect(audit).not.toContain("34600000011");
    expect(audit).not.toContain("600");
    expect(audit).not.toContain("Ada Lovelace");
  });
});

// --- New template (routes/templates.tsx + components/templates/create-template-sheet.tsx) ---

/**
 * These live here, next to `sendTemplateTest`, rather than in a file of their
 * own: the auth seam and the tenant module are mocked ONCE at this file's top
 * level, and those registrations are process-global and outlive the file (see
 * the header, and `helpers/server-fn-mocks`). A second file re-registering them
 * would be a fresh instance of exactly the hazard that helper exists to close.
 */
describe("createTemplate (New template sheet)", () => {
  const DRAFT = {
    wabaId: "waba-a",
    name: "order_update",
    language: "en_US",
    category: "UTILITY" as const,
    bodyText: "Hi {{1}}, your order is on its way.",
    bodyExamples: ["Ada"],
  };

  test("forwards the validated draft and the resolved accountId to the binding", async () => {
    const calls: unknown[][] = [];
    withResources({
      createTemplate: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true, id: "1234567890", status: "PENDING", category: "UTILITY" };
      },
    });
    const res = await createTemplate({ data: DRAFT });
    expect(res).toEqual({
      ok: true,
      data: { ok: true, id: "1234567890", status: "PENDING", category: "UTILITY" },
    });
    expect(calls).toEqual([[DRAFT, "account-a"]]);
  });

  test("refuses every draft the gateway must never be asked to author", () => {
    // The gateway re-checks these shapes and THROWS on them, so its throws are
    // unreachable only while THIS validator is the strict one. Each case is a
    // sentence the sheet can show instead of a server error.
    expect(() => validateCreateTemplateInput({ ...DRAFT, name: "Order_Update" })).toThrow(
      /lowercase/,
    );
    expect(() => validateCreateTemplateInput({ ...DRAFT, name: "order-update" })).toThrow(
      /lowercase/,
    );
    expect(() => validateCreateTemplateInput({ ...DRAFT, language: "english" })).toThrow(/language/);
    expect(() => validateCreateTemplateInput({ ...DRAFT, category: "AUTHENTICATION" })).toThrow(
      /MARKETING or UTILITY/,
    );
    expect(() => validateCreateTemplateInput({ ...DRAFT, wabaId: undefined })).toThrow(/wabaId/);
    // The agreement with the send surface, enforced on the SERVER: a body the
    // "Send test" sheet could not read is a body this cannot author.
    expect(() =>
      validateCreateTemplateInput({ ...DRAFT, bodyText: "Hi {{customer_name}}" }),
    ).toThrow(/Named parameters/);
    expect(() => validateCreateTemplateInput({ ...DRAFT, bodyText: "Hi {{1}}, ref {{3}}" })).toThrow(
      /no gaps/,
    );
    expect(() => validateCreateTemplateInput({ ...DRAFT, bodyText: "" })).toThrow(/empty/);
    // One example per variable, no more and no fewer: Meta requires an example
    // value for every parameter, and a mismatch would misalign them silently.
    expect(() => validateCreateTemplateInput({ ...DRAFT, bodyExamples: [] })).toThrow(
      /exactly 1 example/,
    );
    expect(() => validateCreateTemplateInput({ ...DRAFT, bodyExamples: ["Ada", "extra"] })).toThrow(
      /exactly 1 example/,
    );
    expect(() => validateCreateTemplateInput({ ...DRAFT, bodyExamples: ["  "] })).toThrow(
      /needs an example value/,
    );
    // The send validator's exact character rules: an example travels to Meta as
    // content in the same way a send parameter does.
    expect(() => validateCreateTemplateInput({ ...DRAFT, bodyExamples: ["one\ntwo"] })).toThrow(
      /line breaks/,
    );
  });

  test("keeps the body byte-for-byte, so the preview cannot be a lie", () => {
    // Whitespace at either end is part of the message Meta will store. Trimming
    // it here would make what the operator previewed differ from what is sent.
    const spaced = validateCreateTemplateInput({ ...DRAFT, bodyText: "  Hi {{1}}  " });
    expect(spaced.bodyText).toBe("  Hi {{1}}  ");
  });

  test("requires configure: a role without it is refused and the binding is never touched", async () => {
    // Authoring is durable tenant state at Meta under the business's name — the
    // `configure` class, not `operate`. A viewer or operator session cannot
    // spend the WABA's template quota or its review standing.
    let called = false;
    withResources({
      createTemplate: async () => {
        called = true;
        return { ok: true, id: "1", status: "PENDING", category: "UTILITY" };
      },
    });
    fakeDeniedActions = new Set(["configure"]);
    const res = await createTemplate({ data: DRAFT });
    // Classified from the error's TYPE (eccos-k5a): a permission refusal is
    // `forbidden`, never `unreachable`.
    expect(res).toMatchObject({ ok: false, kind: "forbidden", reason: "missing-permission" });
    expect(called).toBe(false);
  });

  test("fails closed without a session", async () => {
    let called = false;
    withResources({
      createTemplate: async () => {
        called = true;
        return { ok: true, id: "1", status: "PENDING", category: "UTILITY" };
      },
    });
    fakeSessionHeaders = null;
    const res = await createTemplate({ data: DRAFT });
    expect(res).toMatchObject({ ok: false, kind: "unauthenticated" });
    expect(called).toBe(false);
  });

  test("a WABA the account does not own is refused before Meta is called", async () => {
    let called = false;
    withResources({
      createTemplate: async () => {
        called = true;
        return { ok: true, id: "1", status: "PENDING", category: "UTILITY" };
      },
    });
    const res = await createTemplate({ data: { ...DRAFT, wabaId: "waba-foreign" } });
    expect(res).toMatchObject({ ok: false, kind: "unreachable" });
    expect(called).toBe(false);
  });

  test("a refused creation comes back as the typed inner failure, not a thrown error", async () => {
    withResources({
      createTemplate: async () => ({ ok: false, code: "name_taken", detail: "already exists" }),
    });
    expect(await createTemplate({ data: DRAFT })).toEqual({
      ok: true,
      data: { ok: false, code: "name_taken", detail: "already exists" },
    });
  });

  test("the audit record carries NO body text and NO example value", async () => {
    // THIS TEST EXISTS TO FAIL the moment someone "helpfully" adds the body to
    // the audit line. Body text and example values are message content, and
    // audit logs are neither retention-expired nor reachable by `eraseByPhone`
    // — content written here could never be erased again. The template NAME is
    // an identifier and stays, exactly as it does for `template_test_send`.
    withResources({
      createTemplate: async () => ({
        ok: true,
        id: "1234567890",
        status: "PENDING",
        category: "MARKETING",
      }),
    });
    const emitted: string[] = [];
    const original = console.info;
    console.info = (line: string) => {
      emitted.push(String(line));
    };
    try {
      await createTemplate({
        data: {
          ...DRAFT,
          bodyText: "Hi {{1}}, your parcel reaches you today.",
          bodyExamples: ["Ada Lovelace"],
        },
      });
    } finally {
      console.info = original;
    }
    const audit = emitted.find((line) => line.includes('"area":"audit"'));
    expect(audit).toBeDefined();
    expect(audit).toContain('"action":"template_create"');
    expect(audit).toContain('"template":"order_update"');
    expect(audit).toContain('"templateId":"1234567890"');
    expect(audit).toContain('"category":"UTILITY"');
    expect(audit).not.toContain("parcel");
    expect(audit).not.toContain("Ada Lovelace");
  });
});

describe("deleteTemplate (row action)", () => {
  const TARGET = { wabaId: "waba-a", name: "order_update", templateId: "1234567890" };

  test("forwards the name AND the Graph id, so one translation is removed", async () => {
    // Never a bare name: Meta's name-only DELETE removes every language of the
    // template, and the row the operator clicked is one name+language pair.
    const calls: unknown[][] = [];
    withResources({
      deleteTemplate: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true };
      },
    });
    expect(await deleteTemplate({ data: TARGET })).toEqual({ ok: true, data: { ok: true } });
    expect(calls).toEqual([[TARGET, "account-a"]]);
  });

  test("refuses a target the gateway must never be asked to delete", () => {
    expect(() => validateDeleteTemplateInput({ ...TARGET, templateId: "" })).toThrow(/template id/);
    expect(() => validateDeleteTemplateInput({ ...TARGET, templateId: "abc" })).toThrow(
      /template id/,
    );
    expect(() => validateDeleteTemplateInput({ ...TARGET, name: "Order Update" })).toThrow(
      /template name/,
    );
    expect(() => validateDeleteTemplateInput({ ...TARGET, wabaId: undefined })).toThrow(/wabaId/);
  });

  test("requires configure, and audits the identifiers only", async () => {
    withResources({ deleteTemplate: async () => ({ ok: true }) });
    fakeDeniedActions = new Set(["configure"]);
    expect(await deleteTemplate({ data: TARGET })).toMatchObject({
      ok: false,
      kind: "forbidden",
      reason: "missing-permission",
    });

    fakeDeniedActions = new Set();
    const emitted: string[] = [];
    const original = console.info;
    console.info = (line: string) => {
      emitted.push(String(line));
    };
    try {
      await deleteTemplate({ data: TARGET });
    } finally {
      console.info = original;
    }
    const audit = emitted.find((line) => line.includes('"area":"audit"'));
    expect(audit).toContain('"action":"template_delete"');
    expect(audit).toContain('"templateId":"1234567890"');
  });
});

// --- Settings view (routes/settings.tsx) ---

describe("getSubscriberConfig / setSubscriberConfig / resubscribe (Settings view)", () => {
  test("getSubscriberConfig reachable: returns the config without the secret", async () => {
    withResources({
      getSubscriberConfig: async () => ({ url: "https://example.com/webhook", hasSecret: true }),
    });
    const res = await getSubscriberConfig();
    expect(res).toEqual({ ok: true, data: { url: "https://example.com/webhook", hasSecret: true } });
  });

  test("getSubscriberConfig unreachable: missing binding yields the graceful error shape", async () => {
    withResources({});
    gatewayBinding = undefined;
    const res = await getSubscriberConfig();
    expect(res).toEqual(unreachable(UNCONFIGURED_ERROR));
  });

  test("setSubscriberConfig reachable: forwards the rotation payload", async () => {
    const received: unknown[] = [];
    withResources({
      setSubscriberConfig: async (input: unknown) => {
        received.push(input);
        return { ok: true };
      },
    });
    const res = await setSubscriberConfig({ data: { url: "https://new.example.com", secret: "s3cr3t" } });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(received).toEqual([{ url: "https://new.example.com", secret: "s3cr3t" }]);
  });

  test("setSubscriberConfig unreachable: throw is surfaced as { ok: false }", async () => {
    withResources({
      setSubscriberConfig: async () => {
        throw new Error("write failed");
      },
    });
    const res = await setSubscriberConfig({ data: { url: "https://new.example.com" } });
    expect(res).toEqual(unreachable("write failed"));
  });

  test("resubscribe reachable + Meta accepted", async () => {
    withResources({ resubscribe: async () => ({ ok: true }) });
    const res = await resubscribe();
    expect(res).toEqual({ ok: true, data: { ok: true } });
  });

  test("resubscribe reachable but Meta rejected: inner error is preserved", async () => {
    withResources({ resubscribe: async () => ({ ok: false, error: "callback URL not verified" }) });
    const res = await resubscribe();
    expect(res).toEqual({ ok: true, data: { ok: false, error: "callback URL not verified" } });
  });

  test("resubscribe unreachable: missing binding yields the graceful error shape", async () => {
    withResources({});
    gatewayBinding = undefined;
    const res = await resubscribe();
    expect(res).toEqual(unreachable(UNCONFIGURED_ERROR));
  });
});

/**
 * eccos-lpk: /numbers can re-check a number whose provisioning has not landed.
 *
 * The point of this surface is the `pending` WABA, which every other server
 * function refuses to scope to — so these pin that it reaches the gateway at
 * all, that the account still comes from the organization link, and that a WABA
 * the account does not own never gets there.
 */
describe("recheckNumber (pending number on /numbers)", () => {
  test("forwards the owned WABA with the server-resolved account id", async () => {
    const calls: unknown[][] = [];
    withResources({
      reconcileWaba: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true, status: "active", error: null };
      },
    });
    const res = await recheckNumber({ data: { wabaId: "waba-a" } });
    expect(res).toEqual({ ok: true, data: { ok: true, status: "active", error: null } });
    // The browser supplies the WABA id only; the account id is the link's.
    expect(calls).toEqual([["waba-a", "account-a"]]);
  });

  test("a still-pending answer is reported as-is, not dressed up as success", async () => {
    withResources({
      reconcileWaba: async () => ({
        ok: true,
        status: "pending",
        error: "subscribed_apps failed with HTTP 503",
      }),
    });
    const res = await recheckNumber({ data: { wabaId: "waba-a" } });
    expect(res).toEqual({
      ok: true,
      data: { ok: true, status: "pending", error: "subscribed_apps failed with HTTP 503" },
    });
  });

  test("a WABA the account does not own never reaches the gateway", async () => {
    let called = false;
    withResources({
      reconcileWaba: async () => {
        called = true;
        return { ok: true, status: "active", error: null };
      },
    });
    const res = await recheckNumber({ data: { wabaId: "waba-someone-else" } });
    expect(res).toEqual(
      unreachable('WABA "waba-someone-else" is not owned by account "account-a"'),
    );
    expect(called).toBe(false);
  });

  test("fails closed without a session", async () => {
    withResources({ reconcileWaba: async () => ({ ok: true, status: "active", error: null }) });
    fakeSessionHeaders = null;
    // The permission check now runs inside the failure boundary, so a lost
    // session comes back classified instead of escaping as a thrown 500.
    const res = await recheckNumber({ data: { wabaId: "waba-a" } });
    expect(res).toEqual({
      ok: false,
      kind: "unauthenticated",
      error: "authentication required",
    });
  });

  test("unreachable: missing binding yields the graceful error shape", async () => {
    withResources({});
    gatewayBinding = undefined;
    const res = await recheckNumber({ data: { wabaId: "waba-a" } });
    expect(res).toEqual(unreachable(UNCONFIGURED_ERROR));
  });
});

/**
 * The pasted-token connect form (eccos-up9), from the server boundary's side.
 *
 * These live here for the same reason the template ones do: the auth seam and
 * the tenant module are mocked once at this file's top level, and those
 * registrations are process-global.
 *
 * The token in these tests is a stand-in for a LIVE credential a human typed
 * into a browser, so half of what is asserted is where it must NOT go.
 */
describe("connectWithToken (pasted-token panel on Settings)", () => {
  const TOKEN = "EAAtestpastedtoken000000000000";

  test("forwards the token verbatim, once, with the account id from the org link", async () => {
    const calls: unknown[][] = [];
    withResources({
      connectWabaWithToken: async (...args: unknown[]) => {
        calls.push(args);
        return {
          ok: true,
          waba_id: "waba-new",
          phone_number_id: "phone-new",
          display_phone_number: "+34600000000",
          connected: [
            { waba_id: "waba-new", phone_number_id: "phone-new", display_phone_number: "+34600000000" },
          ],
          status: "active",
        };
      },
    });
    const res = await connectWithToken({ data: { token: TOKEN } });
    expect(res.ok).toBe(true);
    // The browser supplies the token; the account is never its to pick, and one
    // submit is exactly one crossing of the binding.
    expect(calls).toEqual([["account-a", TOKEN, undefined]]);
  });

  test("requires administer: a role without it is refused and the token never crosses the binding", async () => {
    // INVARIANT: permission is checked BEFORE the credential moves. This action
    // deposits a long-lived Meta token into tenant state, which is why it sits
    // with connect/exchange at `administer` rather than with `configure`.
    let called = false;
    withResources({
      connectWabaWithToken: async () => {
        called = true;
        return { ok: false, code: "failed", detail: null };
      },
    });
    fakeDeniedActions = new Set(["administer"]);
    const res = await connectWithToken({ data: { token: TOKEN } });
    expect(res).toMatchObject({ ok: false, kind: "forbidden", reason: "missing-permission" });
    expect(called).toBe(false);
  });

  test("fails closed without a session", async () => {
    let called = false;
    withResources({
      connectWabaWithToken: async () => {
        called = true;
        return { ok: false, code: "failed", detail: null };
      },
    });
    fakeSessionHeaders = null;
    const res = await connectWithToken({ data: { token: TOKEN } });
    expect(res).toMatchObject({ ok: false, kind: "unauthenticated" });
    expect(called).toBe(false);
  });

  test("refuses the pastes that are not a token", () => {
    // INVARIANT: the console validator is the strict one, which is what keeps
    // the gateway's mirrored throw unreachable. Each case is a sentence the
    // panel can show instead of a server error.
    expect(() => validateTokenConnectInput({ token: "" })).toThrow(/token is required/);
    expect(() => validateTokenConnectInput({ token: "   " })).toThrow(/token is required/);
    expect(() => validateTokenConnectInput({ token: "EAAshort" })).toThrow(/Meta access token/);
    expect(() => validateTokenConnectInput({ token: "x".repeat(1025) })).toThrow(/Meta access token/);
    // The two pastes that actually happen: a whole curl command, and a token
    // that wrapped across lines in a terminal.
    expect(() =>
      validateTokenConnectInput({ token: `curl -H "Authorization: Bearer ${TOKEN}"` }),
    ).toThrow(/no spaces/);
    expect(() => validateTokenConnectInput({ token: `EAAtestpasted\ntoken0000000000` })).toThrow(
      /no spaces/,
    );
    // Surrounding whitespace is a paste artefact, not an error.
    expect(validateTokenConnectInput({ token: `  ${TOKEN}\n` })).toEqual({ token: TOKEN });
    expect(validateTokenConnectInput({ token: TOKEN, wabaId: "waba-b" })).toEqual({
      token: TOKEN,
      wabaId: "waba-b",
    });
  });

  test("passes the gateway's closed codes through unaltered", async () => {
    // INVARIANT: the server fn never rewrites a closed code or invents copy for
    // it — `lib/failure.ts` owns the wording, keyed on the code alone.
    withResources({
      connectWabaWithToken: async () => ({ ok: false, code: "foreign_app", detail: null }),
    });
    const res = await connectWithToken({ data: { token: TOKEN } });
    expect(res).toEqual({ ok: true, data: { ok: false, code: "foreign_app", detail: null } });
  });

  test("the audit record carries NO token, and no fragment of one", async () => {
    // THIS TEST EXISTS TO FAIL the moment someone adds a prefix, a suffix, or a
    // length to the audit line. The token is a live credential; an audit log is
    // neither retention-expired nor erasable, so anything derived from it here
    // would be unremovable — and would narrow the search space for whoever
    // reads the log.
    withResources({
      connectWabaWithToken: async () => ({
        ok: true,
        waba_id: "waba-new",
        phone_number_id: "phone-new",
        display_phone_number: "+34600000000",
        connected: [
          { waba_id: "waba-new", phone_number_id: "phone-new", display_phone_number: "+34600000000" },
        ],
        status: "active",
      }),
    });
    const emitted: string[] = [];
    const original = console.info;
    console.info = (line: string) => {
      emitted.push(String(line));
    };
    try {
      await connectWithToken({ data: { token: TOKEN } });
    } finally {
      console.info = original;
    }
    const audit = emitted.find((line) => line.includes('"area":"audit"'));
    expect(audit).toBeDefined();
    expect(audit).toContain('"action":"connect_token"');
    expect(audit).toContain('"wabaId":"waba-new"');
    expect(audit).not.toContain(TOKEN);
    // Not even the first characters of it, which is the shape a "safe prefix"
    // would take.
    expect(audit).not.toContain("EAA");
    expect(audit).not.toContain(String(TOKEN.length));
  });

  test("a refused attempt is audited as a failure, by code, with no token", async () => {
    withResources({
      connectWabaWithToken: async () => ({
        ok: false,
        code: "multiple",
        detail: null,
        candidates: [
          { wabaId: "waba-1", phones: [] },
          { wabaId: "waba-2", phones: [] },
        ],
      }),
    });
    const emitted: string[] = [];
    const original = console.info;
    console.info = (line: string) => {
      emitted.push(String(line));
    };
    try {
      await connectWithToken({ data: { token: TOKEN } });
    } finally {
      console.info = original;
    }
    const audit = emitted.find((line) => line.includes('"area":"audit"'));
    expect(audit).toContain('"outcome":"failed"');
    expect(audit).toContain('"code":"multiple"');
    expect(audit).toContain('"candidates":2');
    expect(audit).not.toContain(TOKEN);
  });

  test("unreachable: missing binding yields the graceful error shape", async () => {
    withResources({});
    gatewayBinding = undefined;
    const res = await connectWithToken({ data: { token: TOKEN } });
    expect(res).toEqual(unreachable(UNCONFIGURED_ERROR));
  });
});

/**
 * eccos-k5a: authorization refusals happen in the identity plane, before any
 * RPC is attempted, so they must NOT come back as "the gateway is unreachable".
 * The boundary decides that from the thrown error's type, and these are the
 * three dead ends an operator actually lands on.
 */
describe("failure classification (authorization vs. transport)", () => {
  /** A signed-in session over a binding that records whether anything reached it. */
  function trackingBinding() {
    const touched = { rpc: false };
    fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
    const touch = <T>(value: T) => async () => {
      touched.rpc = true;
      return value;
    };
    gatewayBinding = {
      getOrganizationAccountLink: touch({ accountId: "account-a", status: "active" }),
      ensureOrganizationAccount: touch({ accountId: "account-a", status: "active" }),
      listAccountResources: touch(resourcesFor("account-a")),
      getStatus: touch(null),
      getSubscriberConfig: touch(null),
    };
    return touched;
  }

  test("zero memberships is reported as an onboarding dead end, not an outage", async () => {
    const touched = trackingBinding();
    fakeMemberships = [];
    const res = await getGatewayStatus();
    expect(res).toEqual({
      ok: false,
      kind: "forbidden",
      reason: "no-organization",
      error: "no organization membership — create or join an organization first",
    });
    expect(touched.rpc).toBe(false);
  });

  test("several memberships and none selected carries the choice to make", async () => {
    const touched = trackingBinding();
    fakeMemberships = [
      { id: "org-fixture", name: "Acme" },
      { id: "org-other", name: "Globex" },
    ];
    const res = await getSubscriberConfig();
    expect(res).toEqual({
      ok: false,
      kind: "forbidden",
      reason: "select-organization",
      error: "select an organization",
      // The remedy travels with the failure: the picker needs the options.
      organizations: [
        { id: "org-fixture", name: "Acme" },
        { id: "org-other", name: "Globex" },
      ],
    });
    expect(touched.rpc).toBe(false);
  });

  test("a role without the action is reported as a permission, not a binding", async () => {
    withResources({
      resubscribe: async () => ({ ok: true, error: null }),
      listInbound: async () => [],
    });
    fakeDeniedActions = new Set(["configure"]);
    const res = await resubscribe();
    expect(res).toEqual({
      ok: false,
      kind: "forbidden",
      reason: "missing-permission",
      error: 'missing "configure" permission in this organization',
    });
    // The same session still holds `view`, so the read paths stay open.
    fakeDeniedActions = new Set(["configure"]);
    const readable = await listInbound();
    expect(readable.ok).toBe(true);
  });

  test("a genuine RPC failure still reads as unreachable", async () => {
    withResources({
      getStatus: async () => {
        throw new Error("Durable Object reset");
      },
    });
    const res = await getGatewayStatus();
    expect(res).toEqual(unreachable("Durable Object reset"));
  });
});
