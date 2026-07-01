import { describe, expect, mock, test } from "bun:test";

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

mock.module("cloudflare:workers", () => ({
  env: {
    get GATEWAY() {
      return gatewayBinding;
    },
  },
}));

mock.module("@tanstack/react-start", () => ({
  createServerFn: (_opts?: unknown) => {
    const api = {
      validator: (_v: unknown) => api,
      handler: (fn: (arg?: unknown) => unknown) => (arg?: unknown) => fn(arg),
    };
    return api;
  },
}));

const {
  getGatewayStatus,
  listDeliveries,
  listInbound,
  listOutbound,
  listTemplates,
  retryDelivery,
  getSubscriberConfig,
  setSubscriberConfig,
  resubscribe,
} = await import("../src/server/gateway");

const UNCONFIGURED_ERROR = "GATEWAY service binding is not configured";

// --- Status view (routes/index.tsx) ---

describe("getGatewayStatus (Status view)", () => {
  test("reachable: returns the gateway's status payload", async () => {
    gatewayBinding = {
      getStatus: async () => ({
        name: "eccos",
        version: "1.2.3",
        health: "healthy",
        connection: {
          wabaId: "waba-1",
          phoneNumberId: "phone-1",
          displayPhone: "+1 555",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
        counts: { inbound: 3, outbound: { sent: 2 }, deliveries: { delivered: 2 } },
      }),
    };
    const res = await getGatewayStatus();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status.health).toBe("healthy");
      expect(res.status.connection.wabaId).toBe("waba-1");
    }
  });

  test("unreachable: missing GATEWAY binding yields the graceful error shape", async () => {
    gatewayBinding = undefined;
    const res = await getGatewayStatus();
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
  });

  test("unreachable: RPC throw is caught and surfaced as { ok: false }", async () => {
    gatewayBinding = {
      getStatus: async () => {
        throw new Error("Durable Object unreachable");
      },
    };
    const res = await getGatewayStatus();
    expect(res).toEqual({ ok: false, error: "Durable Object unreachable" });
  });
});

// --- Deliveries view (routes/deliveries.tsx) ---

describe("listDeliveries / retryDelivery (Deliveries view)", () => {
  test("reachable: forwards filter options and returns rows", async () => {
    let receivedOpts: unknown;
    gatewayBinding = {
      listDeliveries: async (opts: unknown) => {
        receivedOpts = opts;
        return [{ id: 1, status: "failed", attempts: 2, last_error: "timeout", next_attempt_at: 0, created_at: 0, payload: "{}" }];
      },
    };
    const res = await listDeliveries({ data: { status: "failed", before: 100 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0]?.status).toBe("failed");
    expect(receivedOpts).toEqual({ status: "failed", before: 100 });
  });

  test("unreachable: throw is surfaced as { ok: false }", async () => {
    gatewayBinding = {
      listDeliveries: async () => {
        throw new Error("network error");
      },
    };
    const res = await listDeliveries({ data: undefined });
    expect(res).toEqual({ ok: false, error: "network error" });
  });

  test("retryDelivery reachable: returns the previous status", async () => {
    gatewayBinding = {
      retryDelivery: async (id: number) => ({ ok: true, previousStatus: id === 7 ? "failed" : null }),
    };
    const res = await retryDelivery({ data: 7 });
    expect(res).toEqual({ ok: true, data: { ok: true, previousStatus: "failed" } });
  });

  test("retryDelivery unreachable: missing binding yields the graceful error shape", async () => {
    gatewayBinding = undefined;
    const res = await retryDelivery({ data: 7 });
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
  });
});

// --- Inbound view (routes/inbound.tsx) ---

describe("listInbound (Inbound view)", () => {
  test("reachable: returns inbound rows", async () => {
    gatewayBinding = {
      listInbound: async () => [
        { id: 1, type: "message", transport_message_id: "wamid.1", message_id: null, payload: "{}", received_at: 0 },
      ],
    };
    const res = await listInbound();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(1);
  });

  test("unreachable: throw is surfaced as { ok: false }", async () => {
    gatewayBinding = {
      listInbound: async () => {
        throw new Error("boom");
      },
    };
    const res = await listInbound();
    expect(res).toEqual({ ok: false, error: "boom" });
  });
});

// --- Outbound view (routes/outbound.tsx) ---

describe("listOutbound (Outbound view)", () => {
  test("reachable: returns outbound rows", async () => {
    gatewayBinding = {
      listOutbound: async () => [
        { id: 1, transport_message_id: "wamid.1", recipient: "+1", request: "{}", status: "sent", error: null, created_at: 0 },
      ],
    };
    const res = await listOutbound();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0]?.status).toBe("sent");
  });

  test("unreachable: missing binding yields the graceful error shape", async () => {
    gatewayBinding = undefined;
    const res = await listOutbound();
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
  });
});

// --- Templates view (routes/templates.tsx) — has a second, inner ok/error layer ---

describe("listTemplates (Templates view)", () => {
  test("reachable + Meta fetch ok: returns the inner templates payload", async () => {
    gatewayBinding = {
      listTemplates: async () => ({ ok: true, data: { data: [{ name: "hello_world", language: "en_US", status: "approved" }] } }),
    };
    const res = await listTemplates();
    expect(res.ok).toBe(true);
    if (res.ok && res.data.ok) {
      const inner = res.data.data as { data: Array<{ name: string }> };
      expect(inner.data[0]?.name).toBe("hello_world");
    }
  });

  test("reachable but Meta rejected: inner { ok: false } is preserved", async () => {
    gatewayBinding = {
      listTemplates: async () => ({ ok: false, error: "Meta API error" }),
    };
    const res = await listTemplates();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ ok: false, error: "Meta API error" });
  });

  test("unreachable: throw is surfaced as the outer { ok: false }", async () => {
    gatewayBinding = {
      listTemplates: async () => {
        throw new Error("RPC unreachable");
      },
    };
    const res = await listTemplates();
    expect(res).toEqual({ ok: false, error: "RPC unreachable" });
  });
});

// --- Settings view (routes/settings.tsx) ---

describe("getSubscriberConfig / setSubscriberConfig / resubscribe (Settings view)", () => {
  test("getSubscriberConfig reachable: returns the config without the secret", async () => {
    gatewayBinding = {
      getSubscriberConfig: async () => ({ url: "https://example.com/webhook", hasSecret: true }),
    };
    const res = await getSubscriberConfig();
    expect(res).toEqual({ ok: true, data: { url: "https://example.com/webhook", hasSecret: true } });
  });

  test("getSubscriberConfig unreachable: missing binding yields the graceful error shape", async () => {
    gatewayBinding = undefined;
    const res = await getSubscriberConfig();
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
  });

  test("setSubscriberConfig reachable: forwards the rotation payload", async () => {
    let received: unknown;
    gatewayBinding = {
      setSubscriberConfig: async (input: unknown) => {
        received = input;
        return { ok: true };
      },
    };
    const res = await setSubscriberConfig({ data: { url: "https://new.example.com", secret: "s3cr3t" } });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(received).toEqual({ url: "https://new.example.com", secret: "s3cr3t" });
  });

  test("setSubscriberConfig unreachable: throw is surfaced as { ok: false }", async () => {
    gatewayBinding = {
      setSubscriberConfig: async () => {
        throw new Error("write failed");
      },
    };
    const res = await setSubscriberConfig({ data: { url: "https://new.example.com" } });
    expect(res).toEqual({ ok: false, error: "write failed" });
  });

  test("resubscribe reachable + Meta accepted", async () => {
    gatewayBinding = { resubscribe: async () => ({ ok: true }) };
    const res = await resubscribe();
    expect(res).toEqual({ ok: true, data: { ok: true } });
  });

  test("resubscribe reachable but Meta rejected: inner error is preserved", async () => {
    gatewayBinding = { resubscribe: async () => ({ ok: false, error: "callback URL not verified" }) };
    const res = await resubscribe();
    expect(res).toEqual({ ok: true, data: { ok: false, error: "callback URL not verified" } });
  });

  test("resubscribe unreachable: missing binding yields the graceful error shape", async () => {
    gatewayBinding = undefined;
    const res = await resubscribe();
    expect(res).toEqual({ ok: false, error: UNCONFIGURED_ERROR });
  });
});
