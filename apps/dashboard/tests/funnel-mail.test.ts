import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { FunnelMailInput } from "@eccos/gateway-contract/funnel-mail";
import { CaptureMailSender, MailProviderError, TEMPLATE_VARIABLES, type MailSender } from "../src/auth/mail";
import { funnelMailSender, funnelRecipients, sendFunnelEmail, type FunnelDeps } from "../src/server/funnel-mail";
import { noteConnectError, RECOVERY_DELAY_MS, runDueRecoveries, scheduleRecovery } from "../src/server/funnel-recovery";

import { FUNNEL_TEMPLATES } from "../src/server/funnel-templates";

/** The D1 statement surface the funnel code uses, over bun:sqlite. */
function d1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind: (...params: Array<string | number | null>) => ({
          first: async () => statement.get(...params) ?? null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => statement.run(...params),
        }),
      };
    },
  } as unknown as D1Database;
}

const NOW = Date.UTC(2026, 10, 25, 9, 42); // Wed 25 Nov, 10:42 in Madrid
const HOUR = 60 * 60 * 1000;

let sqlite: Database;
let mail: CaptureMailSender;
let phones: { displayPhoneNumber: string }[];
let billingStatus: string;

function deps(overrides: Partial<FunnelDeps> = {}): FunnelDeps {
  return {
    db: d1(sqlite),
    mail,
    origin: "https://console.eccos.chat",
    now: () => NOW,
    gateway: {
      getOrganizationAccountLink: async (org: string) => (org === "org_1" ? { accountId: "acc_1", status: "active" } : null),
      listAccountResources: async () => ({ phones }) as never,
      getAccountBilling: async () => ({ billingStatus }) as never,
    },
    ...overrides,
  };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`create table "user" ("id" text primary key, "name" text, "email" text, "emailVerified" integer);
    create table "member" ("id" text primary key, "organizationId" text, "userId" text, "role" text);`);
  sqlite.exec(readFileSync(new URL("../migrations/0007_funnel_mail.sql", import.meta.url), "utf8"));
  const user = sqlite.prepare(`insert into "user" values (?, ?, ?, ?)`);
  const member = sqlite.prepare(`insert into "member" values (?, ?, ?, ?)`);
  user.run("u1", "Marta López", "marta@clinicanorte.es", 1);
  user.run("u2", "Leo", "leo@clinicanorte.es", 1);
  user.run("u3", "Ana", "ana@clinicanorte.es", 1);
  user.run("u4", "Unverified", "nope@clinicanorte.es", 0);
  member.run("m1", "org_1", "u1", "owner");
  member.run("m2", "org_1", "u2", "member, admin");
  member.run("m3", "org_1", "u3", "member");
  member.run("m4", "org_1", "u4", "admin");
  mail = new CaptureMailSender();
  phones = [{ displayPhoneNumber: "+34 612 345 678" }];
  billingStatus = "setup";
});

const activated: FunnelMailInput = {
  kind: "activated",
  organizationId: "org_1",
  accountId: "acc_1",
  activatedAt: NOW,
  via: "outbound",
  windowEndsAt: NOW + 72 * HOUR,
};

function render(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) throw new Error(`missing ${key}`);
    return variables[key];
  });
}

describe("templates", () => {
  test("each declares exactly the variables the console sends", () => {
    for (const t of FUNNEL_TEMPLATES) {
      const used = new Set([...`${t.subject}${t.body_text}${t.body_html}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
      expect([...used].sort()).toEqual([...TEMPLATE_VARIABLES[t.id]].sort());
    }
  });

  test("the copy keeps to the voice: no em dashes, at most one emoji", () => {
    for (const t of FUNNEL_TEMPLATES) {
      expect(t.body_text).not.toContain("—");
      expect([...t.body_text.matchAll(/\p{Extended_Pictographic}/gu)].length).toBeLessThanOrEqual(1);
    }
  });

  test("the activated email renders the sent variables in both parts", async () => {
    await sendFunnelEmail(deps(), activated);
    const sent = mail.sent[0];
    const template = FUNNEL_TEMPLATES.find((t) => t.id === sent.template)!;
    const text = render(template.body_text, sent.variables);
    expect(text).toContain("Hi Marta,");
    expect(text).toContain("Your first message went through Eccos today at 10:42. Your number +34 612 345 678 is set up and working.");
    expect(text).toContain("until Sat 28 Nov at 10:42.");
    expect(text).toContain("Start subscription: https://console.eccos.chat/billing");
    expect(render(template.body_html, sent.variables)).toContain('href="https://console.eccos.chat/billing"');
  });

  test("the paused opening follows why it paused", async () => {
    await sendFunnelEmail(deps(), { kind: "paused", organizationId: "org_1", accountId: "acc_1", pausedAt: NOW, reason: "window_ended" });
    expect(mail.sent[0].variables.opening).toBe("Your setup window ended today at 10:42, so +34 612 345 678 is paused.");
  });

  test("the day-12 warning names both dates and links to Numbers", async () => {
    await sendFunnelEmail(deps(), {
      kind: "never_activated_warning",
      organizationId: "org_1",
      accountId: "acc_1",
      connectedAt: NOW - 12 * 24 * HOUR,
      pausesAt: NOW + 2 * 24 * HOUR,
    });
    expect(mail.sent[0].variables).toMatchObject({ connected_on: "13 Nov", pauses_on: "Fri 27 Nov", url: "https://console.eccos.chat/numbers" });
  });
});

describe("recipients", () => {
  test("owners and admins with a verified address, by first name", async () => {
    expect(await funnelRecipients(d1(sqlite), "org_1")).toEqual([
      { email: "marta@clinicanorte.es", name: "Marta" },
      { email: "leo@clinicanorte.es", name: "Leo" },
    ]);
  });

  test("a call for an account the organization does not own sends nothing", async () => {
    expect(await sendFunnelEmail(deps(), { ...activated, organizationId: "org_2" })).toEqual({ status: "skipped", reason: "not_linked" });
    expect(mail.sent).toHaveLength(0);
  });
});

describe("idempotency", () => {
  test("the same account and kind is sent once", async () => {
    expect(await sendFunnelEmail(deps(), activated)).toEqual({ status: "sent", recipients: 2 });
    expect(await sendFunnelEmail(deps(), activated)).toEqual({ status: "duplicate" });
    expect(mail.sent).toHaveLength(2);
  });

  test("the provider key is stable per recipient and account", async () => {
    const failing: MailSender = {
      async sendTemplate(msg) {
        mail.sent.push(msg);
        if (msg.to.startsWith("leo")) throw new MailProviderError("quota_exceeded", "quota");
        return { status: "sent" };
      },
    };
    await expect(sendFunnelEmail(deps({ mail: failing }), activated)).rejects.toThrow("quota");
    await sendFunnelEmail(deps(), activated);
    expect(mail.sent[0].idempotencyKey).toBe(mail.sent[2].idempotencyKey);
    expect(mail.sent.filter((m) => m.to.startsWith("leo")).map((m) => m.idempotencyKey)).toHaveLength(2);
  });

  test("a 409 means that recipient already had it", async () => {
    const conflict: MailSender = {
      async sendTemplate() {
        throw new MailProviderError("idempotency_conflict", "conflict");
      },
    };
    expect(await sendFunnelEmail(deps({ mail: conflict }), activated)).toEqual({ status: "sent", recipients: 2 });
  });

  test("a warning is dropped once the account subscribed", async () => {
    billingStatus = "active";
    const result = await sendFunnelEmail(deps(), { kind: "window_ending", organizationId: "org_1", accountId: "acc_1", windowEndsAt: NOW });
    expect(result).toEqual({ status: "skipped", reason: "subscribed" });
  });
});

describe("recovery", () => {
  test("goes out 2 hours after the first try, with the cause Meta reported", async () => {
    phones = [];
    await scheduleRecovery(d1(sqlite), { accountId: "acc_1", organizationId: "org_1" }, NOW - RECOVERY_DELAY_MS);
    await scheduleRecovery(d1(sqlite), { accountId: "acc_1", organizationId: "org_1" }, NOW);
    await noteConnectError(d1(sqlite), "acc_1", "3441067");
    await runDueRecoveries(deps());
    expect(mail.sent.map((m) => m.template)).toEqual(["funnel-recovery", "funnel-recovery"]);
    expect(mail.sent[0].variables.situation).toStartWith(
      "I saw your number did not get connected. It looks like another WhatsApp provider is still holding it.",
    );
    expect(mail.sent[0].variables.url).toBe("https://console.eccos.chat/numbers");
    await runDueRecoveries(deps());
    expect(mail.sent).toHaveLength(2);
  });

  test("waits until it is due", async () => {
    phones = [];
    await scheduleRecovery(d1(sqlite), { accountId: "acc_1", organizationId: "org_1" }, NOW - HOUR);
    await runDueRecoveries(deps());
    expect(mail.sent).toHaveLength(0);
  });

  test("is dropped once a number is connected", async () => {
    await scheduleRecovery(d1(sqlite), { accountId: "acc_1", organizationId: "org_1" }, NOW - RECOVERY_DELAY_MS);
    await runDueRecoveries(deps());
    phones = [];
    await runDueRecoveries(deps());
    expect(mail.sent).toHaveLength(0);
  });
});

test("only a production console with the funnel key sends real mail", () => {
  const key = { FUNNEL_RECCADO_API_KEY: "k", FUNNEL_RECCADO_ENDPOINT: "https://mail.example.com/v1/mailboxes/m/transactional/messages" };
  expect(funnelMailSender({ ...key, BETTER_AUTH_URL: "http://localhost:3000" }).constructor.name).toBe("ConsoleMailSender");
  expect(funnelMailSender({ BETTER_AUTH_URL: "https://console.eccos.chat" }).constructor.name).toBe("ConsoleMailSender");
  expect(funnelMailSender({ ...key, BETTER_AUTH_URL: "https://console.eccos.chat" }).constructor.name).toBe("ReccadoMailSender");
});
