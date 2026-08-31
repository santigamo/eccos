import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { EccosControlPlane } from "../../src/control-plane";
import type { EccosGateway } from "../../src/gateway";
import { GatewayRPC } from "../../src/rpc";
import { kickWabaProvisioning } from "../../src/provisioning";
import worker from "../../src/worker";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { getGatewayStubForWaba } from "../../src/gateway-stub";

/**
 * eccos-lpk: the Embedded Signup callback provisions before it redirects.
 *
 * Registration alone only writes a `pending` row, so with provisioning left to
 * the five-minute cron the operator landed on the console looking at a number
 * that would not work yet — the single most visible moment of the product. The
 * callback now kicks the same targeted reconciler the cron uses. These tests pin
 * the three things that kick must never break: it activates the number in the
 * callback, a Meta failure still returns the operator to the console with the
 * row left `pending` for the cron, and it never provisions twice alongside a
 * concurrent cron run.
 */

const CONSOLE_RETURN = "https://app.eccos.chat/numbers";
const WABA_ID = "WABA_KICK";
const PHONE_ID = "PN_KICK";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface GraphOptions {
  /** Ran when Meta's `subscribed_apps` is hit; its Response is the answer. */
  onSubscribe?: () => Promise<Response>;
}

function mockGraph(options: GraphOptions = {}): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "business-token" }), { status: 200 });
    }
    if (url.includes("/debug_token")) {
      return new Response(
        JSON.stringify({
          data: {
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA_ID] }],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes(`/${WABA_ID}/phone_numbers`)) {
      return new Response(
        JSON.stringify({ data: [{ id: PHONE_ID, display_phone_number: "+34 600 000 222" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/subscribed_apps")) {
      return options.onSubscribe
        ? options.onSubscribe()
        : new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
}

function cp<T>(fn: (instance: EccosControlPlane) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getControlPlaneStub(env), fn);
}

function subscribeCalls(graph: MockInstance<typeof fetch>): unknown[] {
  return graph.mock.calls.filter(([input]) => String(input).includes(`/${WABA_ID}/subscribed_apps`));
}

/** The cron reconciler, driven exactly as the every-5-minutes trigger does. */
function runScheduled(): Promise<void> {
  return worker.scheduled(createScheduledController({ scheduledTime: new Date() }), env);
}

let accountId = "";

/** The console's own path into Embedded Signup, up to Meta's redirect back. */
async function startFromConsole(): Promise<{ state: string; cookies: string }> {
  const rpc = new GatewayRPC(createExecutionContext(), env);
  const { url, state } = await rpc.startConnectForAccountId(accountId, CONSOLE_RETURN);
  // `redirect: "manual"` is required: the handoff is now a 302 to Meta
  // (eccos-7jk), and following it would swallow the cookies it just set.
  const handoff = await exports.default.fetch(url, { redirect: "manual" });
  expect(handoff.status).toBe(302);
  return { state, cookies: handoff.headers.getSetCookie().join("; ") };
}

function callback(state: string, cookies: string): Promise<Response> {
  return exports.default.fetch(
    `https://gateway.example/connect?code=oauth-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: cookies }, redirect: "manual" },
  );
}

beforeEach(async () => {
  const rpc = new GatewayRPC(createExecutionContext(), env);
  accountId = (await rpc.ensureOrganizationAccount("org_kick", "Kick workspace")).accountId;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the connect callback provisions before handing the operator back", () => {
  it("activates a freshly registered WABA inside the callback, before any cron run", async () => {
    const graph = mockGraph();
    const { state, cookies } = await startFromConsole();

    const res = await callback(state, cookies);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(CONSOLE_RETURN);
    // The whole point: what the console loads next is already active.
    expect(subscribeCalls(graph)).toHaveLength(1);
    await cp(async (instance) => {
      expect(await instance.getWabaRecord(accountId, WABA_ID)).toMatchObject({
        status: "active",
        provisioningError: null,
      });
    });
    // The data plane is configured too, not just the registry row.
    await runInDurableObject(getGatewayStubForWaba(env, WABA_ID), (instance: EccosGateway) => {
      expect(instance.getConfigValue("META_WABA_ID")).toBe(WABA_ID);
      expect(instance.getConfigValue("META_PHONE_NUMBER_ID")).toBe(PHONE_ID);
    });
  });

  it("leaves the row pending for the cron when Meta fails, and still redirects home", async () => {
    // A retryable Graph failure: the saga must keep the row pending with its
    // backoff, never mark it active, and never cost the operator the way back.
    const graph = mockGraph({
      onSubscribe: async () => new Response("upstream boom", { status: 503 }),
    });
    const { state, cookies } = await startFromConsole();

    const res = await callback(state, cookies);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(CONSOLE_RETURN);
    expect(subscribeCalls(graph)).toHaveLength(1);
    await cp(async (instance) => {
      expect(await instance.getWabaRecord(accountId, WABA_ID)).toMatchObject({
        status: "pending",
        provisionedAt: null,
      });
      const row = instance.sql
        .exec(
          "SELECT provisioning_attempts, provisioning_next_attempt_at, provisioning_lease_until FROM wabas WHERE waba_id = ?",
          WABA_ID,
        )
        .toArray()[0];
      // One attempt spent, lease released, next attempt scheduled: the cron owns
      // it from here.
      expect(row?.provisioning_attempts).toBe(1);
      expect(row?.provisioning_lease_until).toBeNull();
      expect(Number(row?.provisioning_next_attempt_at)).toBeGreaterThan(Date.now());
    });

    // And the cron does finish the job once the backoff is due.
    graph.mockRestore();
    const retryGraph = mockGraph();
    await cp((instance) => {
      instance.sql.exec("UPDATE wabas SET provisioning_next_attempt_at = ? WHERE waba_id = ?", Date.now(), WABA_ID);
    });
    await runScheduled();
    expect(subscribeCalls(retryGraph)).toHaveLength(1);
    await cp(async (instance) => {
      expect((await instance.getWabaRecord(accountId, WABA_ID))?.status).toBe("active");
    });
  });

  it("does not provision twice when the cron fires while the kick is in flight", async () => {
    // The kick takes the same claim the cron takes, so whoever gets the lease is
    // the only one that talks to Meta. Here the kick holds it and the cron runs
    // while `subscribed_apps` is still in flight, which is the interleaving the
    // five-minute trigger can really produce during a connect.
    const inFlight = deferred();
    const release = deferred();
    const graph = mockGraph({
      onSubscribe: async () => {
        inFlight.resolve();
        await release.promise;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      },
    });
    await cp((instance) =>
      instance.beginWabaProvisioning({
        accountId,
        wabaId: WABA_ID,
        metaAccessToken: "business-token",
        callbackUrl: "https://gateway.example/webhooks/meta",
        phones: [{ phoneNumberId: PHONE_ID, displayPhoneNumber: "+34 600 000 222" }],
      }),
    );

    const kick = kickWabaProvisioning(env, accountId, [WABA_ID]);
    await inFlight.promise;
    await runScheduled();
    release.resolve();
    await kick.done;

    expect(subscribeCalls(graph)).toHaveLength(1);
    expect(kick.statuses.get(WABA_ID)).toBe("active");
    await cp(async (instance) => {
      expect(await instance.getWabaRecord(accountId, WABA_ID)).toMatchObject({
        status: "active",
        provisioningError: null,
      });
    });

    // And a cron run after the fact has nothing left to claim either.
    await runScheduled();
    expect(subscribeCalls(graph)).toHaveLength(1);
  });

  it("leaves nothing for the cron once the callback has connected the number", async () => {
    const graph = mockGraph();
    const { state, cookies } = await startFromConsole();
    await callback(state, cookies);
    expect(subscribeCalls(graph)).toHaveLength(1);

    await runScheduled();

    expect(subscribeCalls(graph)).toHaveLength(1);
  });
});
