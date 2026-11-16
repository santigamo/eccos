import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectLinkExchange, ConnectLinkGrant } from "@eccos/gateway-contract";
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

function harness(over: { grant?: ConnectLinkGrant | null; people?: typeof PEOPLE | null; exchange?: ConnectLinkExchange | null } = {}) {
  const calls: unknown[][] = [];
  const strikes: string[] = [];
  let blocked = false;
  const mail = new CaptureMailSender();
  const grant = over.grant === undefined ? GRANT : over.grant;
  const deps: ConnectLinkDeps = {
    gateway: {
      resolveConnectLink: async (...args) => {
        calls.push(["resolve", ...args]);
        return grant;
      },
      startConnectForAccountId: async (...args) => {
        calls.push(["start", ...args]);
        return { url: "https://gateway.test/connect?state=s", state: "state-1", expiresAt: 1 };
      },
      exchangeConnectCodeForLink: async (...args) => {
        calls.push(["exchange", ...args]);
        return over.exchange === undefined ? { grant: { ...GRANT, state: "used" }, result: CONNECTED, notify: true } : over.exchange;
      },
    },
    people: async () => (over.people === undefined ? PEOPLE : over.people),
    limiter: { blocked: async () => blocked, strike: async (caller) => void strikes.push(caller) },
    mail,
    signup: SIGNUP,
    origin: "https://app.eccos.test",
  };
  const call = async (action: string, body: Record<string, unknown> = {}) => {
    const response = await handleConnectLink(action, { token: TOKEN, ...body }, "203.0.113.9", deps);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    call,
    calls,
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
  test("names the workspace and the inviter, and marks the link opened", async () => {
    const h = harness();
    expect(await h.call("view")).toEqual({
      status: 200,
      body: { status: "ready", workspace: "NACEX 2801", inviter: "Rubén", closed: false, signup: SIGNUP },
    });
    expect(h.calls).toEqual([["resolve", TOKEN, true]]);
  });

  test("says a closed workspace is closed before Meta is ever opened", async () => {
    const h = harness({ grant: { ...GRANT, connectPolicy: "closed" } });
    expect((await h.call("view")).body).toMatchObject({ status: "ready", closed: true });
  });

  test("a spent or expired link names who to ask, and nothing else", async () => {
    for (const state of ["used", "expired"] as const) {
      const h = harness({ grant: { ...GRANT, state } });
      expect((await h.call("view")).body).toEqual({ status: "gone", inviter: "Rubén" });
    }
  });

  test("an unknown token learns nothing and counts against the caller", async () => {
    const h = harness({ grant: null });
    expect((await h.call("view")).body).toEqual({ status: "gone", inviter: null });
    expect(h.strikes).toEqual(["203.0.113.9"]);
  });

  test("a link whose creator may no longer connect is gone, without a strike", async () => {
    const h = harness({ people: null });
    expect((await h.call("view")).body).toEqual({ status: "gone", inviter: null });
    expect(h.strikes).toEqual([]);
  });
});

describe("start", () => {
  test("mints the state for the token's account, without marking the link opened", async () => {
    const h = harness();
    expect((await h.call("start", { accountId: "acc_other" })).body).toEqual({ ok: true, state: "state-1" });
    expect(h.calls).toEqual([
      ["resolve", TOKEN, false],
      ["start", "acc_agency"],
    ]);
  });

  test("refuses a closed workspace and a dead link without minting a state", async () => {
    const closed = harness({ grant: { ...GRANT, connectPolicy: "closed" } });
    expect((await closed.call("start")).body).toEqual({ ok: false, code: "subscription_required" });
    const used = harness({ grant: { ...GRANT, state: "used" } });
    expect((await used.call("start")).body).toEqual({ ok: false, code: "gone" });
    for (const h of [closed, used]) expect(h.calls.map((call) => call[0])).toEqual(["resolve"]);
  });
});

describe("exchange", () => {
  test("reports the number, mails the creator, and audits under the creator's id", async () => {
    const h = harness();
    expect((await h.call("exchange", { code: "meta-code", state: "state-1" })).body).toEqual({
      outcome: "connected",
      phone: "+34 600 000 222",
    });
    expect(h.calls.at(-1)).toEqual(["exchange", TOKEN, "meta-code", "state-1"]);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]).toMatchObject({
      template: "connect-link-connected",
      to: "ruben@agency.test",
      variables: { workspace: "NACEX 2801", url: "https://app.eccos.test/numbers" },
    });
    const audit = logged.find((line) => line.includes('"action":"connect_link"')) ?? "";
    expect(audit).toContain('"actorUserId":"user_ruben"');
    expect(audit).toContain('"wabaId":"WABA_1"');
  });

  test("a failure is reported to the page and mailed only when the gateway says so", async () => {
    const failed = { ok: false as const, error: "owned", code: "owned" as const };
    const first = harness({ exchange: { grant: GRANT, result: failed, notify: true } });
    expect((await first.call("exchange", { code: "c", state: "s" })).body).toEqual({ outcome: "owned" });
    expect(first.mail.sent[0]).toMatchObject({ template: "connect-link-failed", to: "ruben@agency.test" });
    expect(Object.keys(first.mail.sent[0]?.variables ?? {}).sort()).toEqual(["reason", "url", "workspace"]);

    const again = harness({ exchange: { grant: GRANT, result: failed, notify: false } });
    await again.call("exchange", { code: "c", state: "s" });
    expect(again.mail.sent).toEqual([]);
  });

  test("a registration without a ready number is pending, and mailed as a failure", async () => {
    const h = harness({
      exchange: { grant: GRANT, result: { ...CONNECTED, connected: [], display_phone_number: "" }, notify: true },
    });
    expect((await h.call("exchange", { code: "c", state: "s" })).body).toEqual({ outcome: "pending" });
    expect(h.mail.sent[0]?.template).toBe("connect-link-failed");
  });

  test("a link that is spent, or held by another exchange, is gone", async () => {
    const h = harness({ exchange: null });
    expect((await h.call("exchange", { code: "c", state: "s" })).body).toEqual({ outcome: "gone" });
    expect(h.mail.sent).toEqual([]);
  });

  test("refuses a missing code or state", async () => {
    const h = harness();
    expect((await h.call("exchange", { code: "", state: "s" })).status).toBe(400);
    expect((await h.call("exchange", { code: "c" })).status).toBe(400);
    expect(h.calls.map((call) => call[0])).not.toContain("exchange");
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

  test("a blocked caller is refused before the token is looked at", async () => {
    const h = harness();
    h.block();
    expect((await h.call("view")).status).toBe(429);
    expect(h.calls).toEqual([]);
  });

  test("an unknown action or a missing token is a bad request", async () => {
    const h = harness();
    expect((await h.call("revoke")).status).toBe(400);
    expect((await h.call("constructor")).status).toBe(400);
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
    for (const secret of ["acc_agency", "org_agency", "user_ruben", "WABA_1", "ruben@agency.test", "rawsecretvalue"]) {
      expect(said).not.toContain(secret);
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain("rawsecretvalue");
  });

  test("a gateway failure answers 502 and logs the error's name only", async () => {
    const h = harness();
    const response = await handleConnectLink("view", { token: TOKEN }, "ip", {
      gateway: {
        resolveConnectLink: async () => {
          throw new Error(`boom ${TOKEN}`);
        },
      },
      limiter: { blocked: async () => false, strike: async () => {} },
    } as unknown as ConnectLinkDeps);
    expect(response.status).toBe(502);
    expect(h.mail.sent).toEqual([]);
    for (const line of logged) expect(line).not.toContain("rawsecretvalue");
  });

  test("only POSTs under its own path are answered", async () => {
    const env = {} as Parameters<typeof connectLinkApi>[2];
    expect(connectLinkApi(new Request("https://app.test/numbers"), "/numbers", env)).toBeNull();
    const get = await connectLinkApi(new Request("https://app.test/api/connect-link/view"), "/api/connect-link/view", env);
    expect(get?.status).toBe(405);
  });
});

describe("attemptLimiter", () => {
  function limiter(clock: { now: number }) {
    const db = new Database(":memory:");
    db.run('create table "rateLimit" ("id" text not null primary key, "key" text not null, "count" integer not null, "lastRequest" bigint not null)');
    return attemptLimiter(d1(db), "connect-link", () => clock.now);
  }

  test("blocks a caller after ten failures, and only that caller", async () => {
    const limit = limiter({ now: 1_000 });
    for (let i = 0; i < 9; i++) await limit.strike("a");
    expect(await limit.blocked("a")).toBe(false);
    await limit.strike("a");
    expect(await limit.blocked("a")).toBe(true);
    expect(await limit.blocked("b")).toBe(false);
  });

  test("forgets the failures once the window has passed", async () => {
    const clock = { now: 1_000 };
    const limit = limiter(clock);
    for (let i = 0; i < 10; i++) await limit.strike("a");
    clock.now += 10 * 60 * 1000;
    expect(await limit.blocked("a")).toBe(false);
    await limit.strike("a");
    expect(await limit.blocked("a")).toBe(false);
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
