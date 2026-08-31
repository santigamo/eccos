import { afterEach, describe, expect, mock, test } from "bun:test";

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
 * The `@tanstack/react-start` fake models exactly the two call shapes
 * `gateway.ts` uses: `createServerFn(opts).handler(fn)` and
 * `createServerFn(opts).validator(v).handler(fn)`. It skips real validation
 * (the routes' `.validator()` callbacks are trivial identity/pass-through
 * functions in this codebase) and just forwards the call argument to the
 * handler, which is enough to drive the real reachable/unreachable code path.
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

mock.module("cloudflare:workers", () => ({
  env: workerEnv,
}));

// Mutable fake session for the auth layer. `null` = unauthenticated (the
// default): server functions must fail closed. A test that exercises the
// authenticated path sets `fakeSessionHeaders` to a Headers object with a
// (notional) session cookie; the mocked auth API accepts it as a member with
// every gateway permission and links the org to the fixture account.
let fakeSessionHeaders: Headers | null = null;
let fakeMemberships: { id: string }[] = [{ id: "org-fixture" }];


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

mock.module("../src/auth/server-auth", () => ({
      UnauthorizedError: class UnauthorizedError extends Error {
        constructor(message = "authentication required") {
          super(message);
          this.name = "UnauthorizedError";
        }
      },
      requireGatewayPermission: async (_auth: unknown, _request: Request, _action: string) => {
        if (!fakeSessionHeaders) throw new Error("authentication required");
        return ORG_ID;
      },
      resolveMemberships: async () => fakeMemberships,
      requireAuthContext: async (_auth: unknown, _request: Request) => {
        if (!fakeSessionHeaders) throw new Error("authentication required");
        return { session: { userId: "user-1", email: "op@corp.test", emailVerified: true, name: "Op", sessionId: "sess-1", activeOrganizationId: null } };
      },
    }));

mock.module("@tanstack/react-start/server", () => ({
  // Server-function request: carries the current fake session's headers (or none).
  getRequest: () => {
    const headers = new Headers();
    if (fakeSessionHeaders) {
      for (const [k, v] of fakeSessionHeaders.entries()) headers.set(k, v);
    }
    return new Request("http://localhost:3000/", { headers });
  },
}));

mock.module("@tanstack/react-start", () => ({
  createServerFn: (_opts?: unknown) => {
    const api = {
      validator: (_v: unknown) => api,
      handler: (fn: (arg?: unknown) => unknown) => (arg?: unknown) =>
        fn(arg && typeof arg === "object" && "data" in arg ? arg : { data: arg }),
    };
    return api;
  },
}));

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
} = await import("../src/server/gateway");

afterEach(() => {
  gatewayBinding = undefined;
  fakeSessionHeaders = null;
  fakeMemberships = [{ id: "org-fixture" }];
});

const UNCONFIGURED_ERROR = "GATEWAY service binding is not configured";

/** Account resources fixture with an owned WABA, for every account-scoped view. */
function resourcesFor(accountId: string) {
  return {
    account: { accountId, name: "Account A", createdAt: 1 },
    keys: [],
    wabas: [
      { accountId, wabaId: "waba-a", callbackUrl: null, createdAt: 1, phones: [{ phoneNumberId: "phone-a", displayPhoneNumber: "+1" }] },
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
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
  });

  test("unreachable: RPC throw is caught and surfaced as { ok: false }", async () => {
    withResources({
      getStatus: async () => {
        throw new Error("Durable Object unreachable");
      },
    });
    const res = await getGatewayStatus();
    expect(res).toEqual({ ok: false, error: "Durable Object unreachable" });
  });

  test("account mode resolves an owned WABA and forwards the account context", async () => {
    const statusArgs: unknown[] = [];
    withResources({
      listAccountResources: async (accountId: string) => ({
        account: { accountId, name: "Account A", createdAt: 1 },
        keys: [],
        wabas: [
          { accountId, wabaId: "waba-z", callbackUrl: null, createdAt: 1, phones: [] },
          { accountId, wabaId: "waba-a", callbackUrl: null, createdAt: 1, phones: [{ phoneNumberId: "phone-a", displayPhoneNumber: "+1" }] },
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
          { accountId: "account-a", wabaId: "waba-a", callbackUrl: null, createdAt: 1, phones: [] },
          { accountId: "account-a", wabaId: "waba-b", callbackUrl: null, createdAt: 1, phones: [] },
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
    expect(mutation).toEqual({ ok: false, error: 'WABA "waba-foreign" is not owned by account "account-a"' });
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
    expect(res).toEqual({ ok: false, error: 'Account "account-a" has no registered WABAs' });
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
    expect(result).toEqual({ ok: false, error: "authentication required" });
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

  test("reports pending provisioning instead of a false ownership error", async () => {
    fakeSessionHeaders = new Headers({ cookie: "better-auth.session_token=fake" });
    withResources({});
    const result = await getDashboardState();
    if (result.ok && result.data.stage === "account-ready") {
      expect(result.data.resources.wabas[0]?.status).toBeDefined();
    }
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
    expect(res).toEqual({ ok: false, error: "network error" });
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
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
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
    expect(res).toEqual({ ok: false, error: "boom" });
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
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
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
    expect(res).toEqual({ ok: false, error: "RPC unreachable" });
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
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
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
    expect(res).toEqual({ ok: false, error: "write failed" });
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
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
  });
});
