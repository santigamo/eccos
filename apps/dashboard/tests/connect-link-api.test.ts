import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectLinkGrant } from "@eccos/gateway-contract";
import { CaptureMailSender } from "../src/auth/mail";
import { attemptLimiter } from "../src/server/attempt-limit";
import { type ConnectLinkDeps, connectLinkApi, handleConnectLink } from "../src/server/connect-link-api";
import { linkPeople } from "../src/server/connect-link-people";

/**
 * The landing page's API: what an anonymous bearer of a link token can do, and
 * everything it cannot see.
 */

const TOKEN = "0123456789abcdef.rawsecretvalue_never_logged_never_echoed00";
const GRANT: ConnectLinkGrant = {
  accountId: "acc_agency",
  organizationId: "org_agency",
  linkId: "link_1",
  creatorUserId: "user_ruben",
  state: "active",
  connectPolicy: "open",
};
const PEOPLE = { workspace: "NACEX 2801", inviter: "Rubén", inviterEmail: "ruben@agency.test" };
const SIGNUP = { appId: "app", configId: "cfg", graphVersion: "v25.0" };
const CONNECTED = {
  ok: true as const,
  waba_id: "WABA_1",
  phone_number_id: "PN_1",
  display_phone_number: "+34 600 000 222",
  connected: [{ waba_id: "WABA_1", phone_number_id: "PN_1", display_phone_number: "+34 600 000 222" }],
  status: "active" as const,
};

/** D1's surface over an in-memory SQLite. */
function d1(db: Database): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...params: (string | number)[]) => ({
        first: async () => db.query(sql).get(...params) ?? null,
        run: async () => void db.query(sql).run(...params),
      }),
    }),
  } as unknown as D1Database;
}

type Settled = Awaited<ReturnType<ConnectLinkDeps["gateway"]["exchangeConnectCodeForClaim"]>>;
type Over = {
  grant?: ConnectLinkGrant | null;
  people?: typeof PEOPLE | null;
  /** What the claim answers; by default the grant, claimed when it is active. */
  claim?: "busy" | Error;
  /** What the exchange answers, or the error it dies with. */
  exchange?: Settled | Error;
  /** What settling the claim as unknown answers after a dead exchange. */
  left?: Awaited<ReturnType<ConnectLinkDeps["gateway"]["settleConnectLink"]>> | Error;
};

function harness(over: Over = {}) {
  const calls: unknown[][] = [];
  const strikes: string[] = [];
  const deferred: Promise<unknown>[] = [];
  let blocked = false;
  const mail = new CaptureMailSender();
  const grant = over.grant === undefined ? GRANT : over.grant;
  const limiter = (name: string) => ({
    strike: async (key: string) => {
      strikes.push(`${name}:${key}`);
      return blocked;
    },
  });
  const deps: ConnectLinkDeps = {
    gateway: {
      resolveConnectLink: async (...args) => {
        calls.push(["resolve", ...args]);
        return grant;
      },
      markConnectLinkOpened: async (...args) => void calls.push(["opened", ...args]),
      startConnectForAccountId: async (...args) => {
        calls.push(["start", ...args]);
        return { url: "https://gateway.test/connect?state=s", state: "state-1", expiresAt: 1 };
      },
      claimConnectLink: async (...args) => {
        calls.push(["claim", ...args]);
        if (over.claim instanceof Error) throw over.claim;
        if (over.claim === "busy") return "busy";
        return grant && { grant, claimId: grant.state === "active" ? "link_1.nonce" : null };
      },
      exchangeConnectCodeForClaim: async (...args) => {
        calls.push(["exchange", ...args]);
        if (over.exchange instanceof Error) throw over.exchange;
        return over.exchange === undefined ? { result: CONNECTED, notify: true, state: "connected" } : over.exchange;
      },
      settleConnectLink: async (...args) => {
        calls.push(["settle", ...args]);
        if (over.left instanceof Error) throw over.left;
        return over.left === undefined ? { notify: true, state: "unconfirmed" } : over.left;
      },
    },
    people: async () => (over.people === undefined ? PEOPLE : over.people),
    failures: limiter("failures"),
    events: limiter("events"),
    starts: limiter("starts"),
    mail,
    defer: (work) => void deferred.push(work),
    signup: SIGNUP,
    origin: "https://app.eccos.test",
  };
  const call = async (action: string, body: Record<string, unknown> = {}) => {
    const response = await handleConnectLink(action, { token: TOKEN, ...body }, "203.0.113.9", deps);
    await Promise.all(deferred);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const steps = () => calls.map((entry) => entry[0]);
  return {
    call,
    calls,
    steps,
    strikes,
    mail,
    block: () => {
      blocked = true;
    },
  };
}

let logged: string[];
const original = { info: console.info, error: console.error };
beforeEach(() => {
  logged = [];
  console.info = (line: string) => void logged.push(String(line));
  console.error = (line: string) => void logged.push(String(line));
});
afterEach(() => {
  Object.assign(console, original);
});

describe("view", () => {
  test("names the workspace and the inviter, and marks the link opened once it has resolved in full", async () => {
    const h = harness();
    expect(await h.call("view")).toEqual({
      status: 200,
      body: { status: "ready", workspace: "NACEX 2801", inviter: "Rubén", closed: false, signup: SIGNUP },
    });
    expect(h.calls).toEqual([
      ["resolve", TOKEN],
      ["opened", "link_1"],
    ]);
  });

  test("says a closed workspace is closed before Meta is ever opened", async () => {
    const h = harness({ grant: { ...GRANT, connectPolicy: "closed" } });
    expect((await h.call("view")).body).toMatchObject({ status: "ready", closed: true });
  });

  test("a spent, expired or replaced link names who to ask, counts no strike and is not marked opened", async () => {
    for (const state of ["used", "expired", "revoked"] as const) {
      const h = harness({ grant: { ...GRANT, state } });
      expect((await h.call("view")).body).toEqual({ status: "gone", inviter: "Rubén" });
      expect(h.steps()).toEqual(["resolve"]);
      expect(h.strikes).toEqual([]);
    }
  });

  test("an unknown token learns nothing and counts against the caller", async () => {
    const h = harness({ grant: null });
    expect((await h.call("view")).body).toEqual({ status: "gone", inviter: null });
    expect(h.strikes).toEqual(["failures:203.0.113.9"]);
  });

  test("a link whose creator may no longer connect is gone, and never reads as opened", async () => {
    const h = harness({ people: null });
    expect((await h.call("view")).body).toEqual({ status: "gone", inviter: null });
    expect(h.strikes).toEqual([]);
    expect(h.steps()).toEqual(["resolve"]);
  });
});

describe("start", () => {
  test("mints the state for the token's account", async () => {
    const h = harness();
    expect((await h.call("start", { accountId: "acc_other" })).body).toEqual({ ok: true, state: "state-1" });
    expect(h.calls).toEqual([
      ["resolve", TOKEN],
      ["start", "acc_agency"],
    ]);
    expect(h.strikes).toEqual(["starts:link_1"]);
  });

  test("refuses a closed workspace and a dead link without minting a state", async () => {
    const closed = harness({ grant: { ...GRANT, connectPolicy: "closed" } });
    expect((await closed.call("start")).body).toEqual({ ok: false, code: "subscription_required" });
    const used = harness({ grant: { ...GRANT, state: "used" } });
    expect((await used.call("start")).body).toEqual({ ok: false, code: "gone" });
    for (const h of [closed, used]) expect(h.steps()).toEqual(["resolve"]);
  });

  test("past the per-link limit it mints nothing and audits nothing", async () => {
    const h = harness();
    h.block();
    expect((await h.call("start")).status).toBe(429);
    expect(h.steps()).toEqual(["resolve"]);
    expect(logged).toEqual([]);
  });
});

describe("exchange", () => {
  const body = { code: "meta-code", state: "state-1" };

  test("claims the link, exchanges under that claim, mails the creator and audits under their id", async () => {
    const h = harness();
    expect((await h.call("exchange", body)).body).toEqual({ outcome: "connected", phone: "+34 600 000 222" });
    expect(h.calls).toEqual([
      ["claim", TOKEN],
      ["exchange", "link_1.nonce", "meta-code", "state-1"],
    ]);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]).toMatchObject({
      template: "connect-link-connected",
      to: "ruben@agency.test",
      variables: { workspace: "NACEX 2801", url: "https://app.eccos.test/numbers" },
    });
    expect(h.mail.sent[0]?.variables.note).toContain("forwarded");
    const audits = logged.filter((line) => line.includes('"action":"connect_link"'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain('"actorUserId":"user_ruben"');
    expect(audits[0]).toContain('"wabaId":"WABA_1"');
  });

  test("numbers left out by a closed workspace are said to the bearer and to the admin", async () => {
    const h = harness({
      exchange: { result: { ...CONNECTED, subscriptionRequired: true }, notify: true, state: "connected" },
    });
    expect((await h.call("exchange", body)).body).toEqual({ outcome: "connected", phone: "+34 600 000 222", leftOut: true });
    expect(h.mail.sent[0]?.template).toBe("connect-link-connected");
    expect(h.mail.sent[0]?.variables.note).toContain("left out");
  });

  test("a failure is reported to the page and mailed only when the gateway says so", async () => {
    const failed = { ok: false as const, error: "owned", code: "owned" as const };
    const first = harness({ exchange: { result: failed, notify: true, state: "pending" } });
    expect((await first.call("exchange", body)).body).toEqual({ outcome: "owned" });
    expect(first.mail.sent[0]).toMatchObject({ template: "connect-link-failed", to: "ruben@agency.test" });
    expect(Object.keys(first.mail.sent[0]?.variables ?? {}).sort()).toEqual(["reason", "url", "workspace"]);

    const again = harness({ exchange: { result: failed, notify: false, state: "pending" } });
    await again.call("exchange", body);
    expect(again.mail.sent).toEqual([]);
  });

  test("a registration without a ready number is pending, and mailed as a failure", async () => {
    const h = harness({
      exchange: { result: { ...CONNECTED, connected: [], display_phone_number: "" }, notify: true, state: "connected" },
    });
    expect((await h.call("exchange", body)).body).toEqual({ outcome: "pending" });
    expect(h.mail.sent[0]?.template).toBe("connect-link-failed");
  });

  test("a link held by another exchange is busy, and one that is not active is gone: neither is exchanged", async () => {
    const held = harness({ claim: "busy" });
    expect((await held.call("exchange", body)).body).toEqual({ outcome: "busy" });
    for (const state of ["used", "expired", "revoked"] as const) {
      const dead = harness({ grant: { ...GRANT, state } });
      expect((await dead.call("exchange", body)).body).toEqual({ outcome: "gone" });
      expect(dead.steps()).toEqual(["claim"]);
    }
    expect(held.steps()).toEqual(["claim"]);
  });

  test("a claim taken for a link whose creator lost access is released, not left held", async () => {
    const h = harness({ people: null });
    expect((await h.call("exchange", body)).body).toEqual({ outcome: "gone" });
    expect(h.calls.at(-1)).toEqual(["settle", "link_1.nonce", { kind: "released" }]);
  });

  test("when the claim itself fails nothing was taken: retry, with the link unspent and no mail", async () => {
    const h = harness({ claim: new Error(`rpc died ${TOKEN}`) });
    expect(await h.call("exchange", body)).toEqual({ status: 200, body: { outcome: "failed" } });
    expect(h.steps()).toEqual(["claim"]);
    expect(h.mail.sent).toEqual([]);
  });

  test("a failure once the registration write began is unknown: never a retry, and the creator is told", async () => {
    const h = harness({ exchange: { result: null, notify: true, state: "unconfirmed" } });
    expect((await h.call("exchange", body)).body).toEqual({ outcome: "unknown" });
    expect(h.mail.sent[0]?.variables.reason).toContain("Open Numbers");
    expect(logged.find((line) => line.includes('"action":"connect_link"'))).toContain('"detail":"unknown"');
    expect(h.steps()).not.toContain("settle");
  });

  test("an exchange that dies without an answer spends only the claim this request holds", async () => {
    const h = harness({ exchange: new Error(`rpc died ${TOKEN}`) });
    expect((await h.call("exchange", body)).body).toEqual({ outcome: "unknown" });
    expect(h.calls.at(-1)).toEqual(["settle", "link_1.nonce", { kind: "unknown" }]);
    expect(h.mail.sent[0]).toMatchObject({ template: "connect-link-failed" });
  });

  test("what the gateway had already recorded wins over the guess", async () => {
    const connected = harness({ exchange: new Error("rpc died"), left: { notify: false, state: "connected" } });
    expect((await connected.call("exchange", body)).body).toEqual({ outcome: "connected", phone: null });
    expect(connected.mail.sent.map((sent) => sent.template)).toEqual(["connect-link-connected"]);

    const failed = harness({ exchange: new Error("rpc died"), left: { notify: false, state: "pending" } });
    expect((await failed.call("exchange", body)).body).toEqual({ outcome: "failed" });
    expect(failed.mail.sent).toEqual([]);
  });

  test("when the link could not be marked either, nothing is mailed that a later result could contradict", async () => {
    const h = harness({ exchange: new Error("rpc died"), left: new Error("still down") });
    expect((await h.call("exchange", body)).body).toEqual({ outcome: "unknown" });
    expect(h.mail.sent).toEqual([]);
  });

  test("the mail's key names the link and the outcome, so a repeat is the same mail", async () => {
    const h = harness();
    await h.call("exchange", body);
    await h.call("exchange", body);
    expect(h.mail.sent[0]?.idempotencyKey).toBe(h.mail.sent[1]?.idempotencyKey);
    const other = harness({ grant: { ...GRANT, linkId: "link_2" } });
    await other.call("exchange", body);
    expect(other.mail.sent[0]?.idempotencyKey).not.toBe(h.mail.sent[0]?.idempotencyKey);
  });

  test("refuses a missing or oversized code or state before the link is taken", async () => {
    const h = harness();
    expect((await h.call("exchange", { code: "", state: "s" })).status).toBe(400);
    expect((await h.call("exchange", { code: "c" })).status).toBe(400);
    expect((await h.call("exchange", { code: "x".repeat(4097), state: "s" })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});

describe("the boundary", () => {
  test("session events are audited under the creator's id", async () => {
    const h = harness();
    await h.call("event", { event: { event: "CANCEL", currentStep: "QR", sessionId: "sess-9" } });
    const audit = logged.find((line) => line.includes('"action":"connect_session_event"')) ?? "";
    expect(audit).toContain('"actorUserId":"user_ruben"');
    expect(audit).toContain('"via":"connect_link"');
    expect(audit).toContain('"sessionId":"sess-9"');
  });

  test("only a wrong token can be refused for trying too often", async () => {
    const wrong = harness({ grant: null });
    wrong.block();
    expect((await wrong.call("view")).status).toBe(429);
    const right = harness();
    right.block();
    expect((await right.call("view")).body).toMatchObject({ status: "ready" });
    expect(right.strikes).toEqual([]);
  });

  test("session events stop at the limit, and are not recorded for a spent or expired link", async () => {
    const event = { event: { event: "CANCEL", sessionId: "sess-9" } };
    const limited = harness();
    limited.block();
    expect(await limited.call("event", event)).toEqual({ status: 200, body: {} });
    for (const state of ["used", "expired", "revoked"] as const) {
      await harness({ grant: { ...GRANT, state } }).call("event", event);
    }
    expect(logged.filter((line) => line.includes("connect_session_event"))).toEqual([]);
  });

  test("an unknown action, a missing token or a malformed event is a bad request", async () => {
    const h = harness();
    expect((await h.call("revoke")).status).toBe(400);
    expect((await h.call("constructor")).status).toBe(400);
    expect((await h.call("event", { event: { event: "" } })).status).toBe(400);
    expect((await h.call("event", {})).status).toBe(400);
    const response = await handleConnectLink("view", {}, "ip", {} as ConnectLinkDeps);
    expect(response.status).toBe(400);
  });

  test("no answer carries an id, and no log line carries the token", async () => {
    const h = harness();
    const answers = [
      await h.call("view"),
      await h.call("start"),
      await h.call("exchange", { code: "c", state: "s" }),
      await h.call("event", { event: { event: "FINISH" } }),
    ];
    const said = JSON.stringify(answers);
    for (const secret of ["acc_agency", "org_agency", "user_ruben", "WABA_1", "ruben@agency.test", "rawsecretvalue", "link_1"]) {
      expect(said).not.toContain(secret);
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain("rawsecretvalue");
  });

  test("a gateway failure answers 502 and logs the error's name only", async () => {
    const response = await handleConnectLink("view", { token: TOKEN }, "ip", {
      gateway: {
        resolveConnectLink: async () => {
          throw new Error(`boom ${TOKEN}`);
        },
      },
    } as unknown as ConnectLinkDeps);
    expect(response.status).toBe(502);
    expect(logged.length).toBe(1);
    for (const line of logged) expect(line).not.toContain("rawsecretvalue");
  });

  test("only POSTs under its own path are answered", async () => {
    const env = {} as Parameters<typeof connectLinkApi>[2];
    const defer = () => {};
    expect(connectLinkApi(new Request("https://app.test/numbers"), "/numbers", env, defer)).toBeNull();
    const get = await connectLinkApi(
      new Request("https://app.test/api/connect-link/view"),
      "/api/connect-link/view",
      env,
      defer,
    );
    expect(get?.status).toBe(405);
  });
});

describe("attemptLimiter", () => {
  function limiter(clock: { now: number }) {
    const db = new Database(":memory:");
    db.run('create table "rateLimit" ("id" text not null primary key, "key" text not null, "count" integer not null, "lastRequest" bigint not null)');
    return { limit: attemptLimiter(d1(db), "connect-link", 10, 10 * 60 * 1000, () => clock.now), db };
  }

  test("is over the limit from the eleventh attempt, for that caller only", async () => {
    const { limit } = limiter({ now: 1_000_000 });
    for (let i = 0; i < 10; i++) expect(await limit.strike("a")).toBe(false);
    expect(await limit.strike("a")).toBe(true);
    expect(await limit.strike("b")).toBe(false);
  });

  test("counts concurrent attempts without losing any: one row, one upsert each", async () => {
    const { limit, db } = limiter({ now: 1_000_000 });
    await Promise.all(Array.from({ length: 10 }, () => limit.strike("a")));
    expect(db.query('select "count" from "rateLimit"').all()).toEqual([{ count: 10 }]);
  });

  test("starts over once the window has passed", async () => {
    const clock = { now: 1_000_000 };
    const { limit } = limiter(clock);
    for (let i = 0; i < 11; i++) await limit.strike("a");
    clock.now += 10 * 60 * 1000;
    expect(await limit.strike("a")).toBe(false);
  });

  test("spent says whether the next attempt would be over, without counting one", async () => {
    const clock = { now: 1_000_000 };
    const { limit, db } = limiter(clock);
    for (let i = 0; i < 9; i++) await limit.strike("a");
    expect(await limit.spent("a")).toBe(false);
    await limit.strike("a");
    expect(await limit.spent("a")).toBe(true);
    expect(db.query('select "count" from "rateLimit"').all()).toEqual([{ count: 10 }]);
    clock.now += 10 * 60 * 1000;
    expect(await limit.spent("a")).toBe(false);
  });
});

describe("linkPeople", () => {
  function people(role: string | null, name = "Rubén") {
    const db = new Database(":memory:");
    db.run('create table "user" ("id" text primary key, "name" text, "email" text)');
    db.run('create table "organization" ("id" text primary key, "name" text)');
    db.run('create table "member" ("id" text primary key, "organizationId" text, "userId" text, "role" text)');
    db.run(`insert into "user" values ('user_ruben', ?, 'ruben@agency.test')`, [name]);
    db.run(`insert into "organization" values ('org_agency', 'NACEX 2801')`);
    if (role) db.run(`insert into "member" values ('m1', 'org_agency', 'user_ruben', ?)`, [role]);
    return linkPeople(d1(db), "org_agency", "user_ruben");
  }

  test("resolves the workspace and its admin", async () => {
    expect(await people("owner")).toEqual(PEOPLE);
    expect(await people("operator,admin")).toEqual(PEOPLE);
    expect((await people("admin", " "))?.inviter).toBe("NACEX 2801");
  });

  test("is null once the creator is not an admin of that workspace", async () => {
    expect(await people("operator")).toBeNull();
    expect(await people(null)).toBeNull();
  });
});
