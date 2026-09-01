/**
 * Per-flow mail policy (eccos-3ne).
 *
 * The same provider status means different things to different flows, so this
 * pins each of the three call sites separately — above all the password-reset
 * path, whose whole job is to say NOTHING an attacker could read as
 * "this address has an account".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import {
  applyInvitationSendPolicy,
  applyResetSendPolicy,
  applyVerificationSendPolicy,
  createAuth,
  type MailPolicyContext,
} from "../src/auth/auth";
import {
  CaptureMailSender,
  deriveIdempotencyKey,
  extractTokenFromUrl,
  MAIL_SUPPRESSED_CODE,
  MAIL_UNDELIVERABLE_CODE,
  MailUndeliverableError,
  type SendOutcome,
} from "../src/auth/mail";
import { ReccadoMailSender } from "../src/auth/mail-reccado";
import { mailUndeliverableMessage } from "../src/components/auth/auth-page";

const SECRET = "test-secret-32-chars-minimum-length!!";
const BASE_URL = "http://localhost:3000";

const CTX: MailPolicyContext = {
  template: "verify-email",
  to: "user@example.com",
  idempotencyKey: "d".repeat(64),
};

const UNRESOLVED: SendOutcome = { status: "unresolved" };
const BOUNCED: SendOutcome = { status: "undeliverable", reason: "permanent_failure" };
const SUPPRESSED: SendOutcome = {
  status: "undeliverable",
  reason: "recipient_suppressed",
};

/** Collect the structured warn lines a policy emits. */
let warnings: string[] = [];
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  warnings = [];
  console.warn = (line: unknown) => {
    warnings.push(String(line));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
});

function parsedWarnings(): Record<string, string>[] {
  return warnings.map((line) => JSON.parse(line) as Record<string, string>);
}

describe("unresolved (504) never throws, at any call site", () => {
  for (const [name, apply] of [
    ["verification", applyVerificationSendPolicy],
    ["reset", applyResetSendPolicy],
    ["invitation", applyInvitationSendPolicy],
  ] as const) {
    test(`${name} logs and continues`, () => {
      expect(() => apply(UNRESOLVED, CTX)).not.toThrow();
      const [event] = parsedWarnings();
      expect(event?.event).toBe("send-unresolved");
      expect(event?.level).toBe("warn");
      expect(event?.area).toBe("auth-mail");
    });
  }

  test("the log carries the domain, the template and the hashed key — never the URL", () => {
    applyVerificationSendPolicy(UNRESOLVED, CTX);
    const [event] = parsedWarnings();
    expect(event?.toDomain).toBe("example.com");
    expect(event?.template).toBe("verify-email");
    expect(event?.idempotencyKey).toBe(CTX.idempotencyKey);
    // The recipient's local-part is not an operational need, and the URL
    // carries an action-capable token.
    expect(warnings[0]).not.toContain("user@example.com");
    expect(warnings[0]!.toLowerCase()).not.toContain("http");
    expect(warnings[0]!.toLowerCase()).not.toContain("token");
  });

  test("it is the ENTIRE record: the outcome is terminal, so nothing is scheduled", () => {
    // A retry or replay loop is explicitly forbidden — a replay under the same
    // key returns the stored status without re-asking the provider, and
    // delivery events cannot resolve it. One log line is the whole mechanism.
    applyVerificationSendPolicy(UNRESOLVED, CTX);
    expect(warnings.length).toBe(1);
  });
});

describe("undeliverable at sign-up is surfaced", () => {
  test("a permanent failure throws the typo-shaped message", () => {
    const error = (() => {
      try {
        applyVerificationSendPolicy(BOUNCED, CTX);
      } catch (e) {
        return e as MailUndeliverableError;
      }
    })();
    expect(error).toBeInstanceOf(MailUndeliverableError);
    expect(error!.code).toBe(MAIL_UNDELIVERABLE_CODE);
    expect(error!.message).toContain("typos");
    // Membership-neutral: it says nothing about whether an account exists.
    expect(error!.message.toLowerCase()).not.toContain("account");
    expect(error!.message.toLowerCase()).not.toContain("registered");
  });

  test("a suppressed recipient gets its OWN message, never the typo one", () => {
    const error = (() => {
      try {
        applyVerificationSendPolicy(SUPPRESSED, CTX);
      } catch (e) {
        return e as MailUndeliverableError;
      }
    })();
    expect(error!.code).toBe(MAIL_SUPPRESSED_CODE);
    expect(error!.message.toLowerCase()).toContain("blocked");
    // Retyping cannot fix a suppression, so the typo advice would be a loop.
    expect(error!.message).not.toContain("typos");
  });

  test("it logs before it throws", () => {
    expect(() => applyVerificationSendPolicy(BOUNCED, CTX)).toThrow();
    const [event] = parsedWarnings();
    expect(event?.event).toBe("send-undeliverable");
    expect(event?.reason).toBe("permanent_failure");
  });
});

describe("undeliverable at password reset is NEVER surfaced", () => {
  test("a permanent failure is swallowed — surfacing it would be a membership oracle", () => {
    // sendResetPassword only runs for accounts that EXIST (better-auth returns
    // the generic response for an unknown address without calling it at all),
    // so a visible difference here would mean "this address has an account".
    expect(() => applyResetSendPolicy(BOUNCED, CTX)).not.toThrow();
  });

  test("a suppressed recipient is swallowed too", () => {
    expect(() => applyResetSendPolicy(SUPPRESSED, CTX)).not.toThrow();
  });

  test("swallowed does not mean unrecorded: it still logs", () => {
    applyResetSendPolicy(BOUNCED, CTX);
    const [event] = parsedWarnings();
    expect(event?.event).toBe("send-undeliverable");
    expect(event?.reason).toBe("permanent_failure");
  });

  test("a successful send says nothing at all", () => {
    applyResetSendPolicy({ status: "sent" }, CTX);
    expect(warnings.length).toBe(0);
  });
});

describe("undeliverable at invitation is surfaced to the inviter", () => {
  test("the inviter is authenticated and typed the address, so they can fix it", () => {
    expect(() => applyInvitationSendPolicy(BOUNCED, CTX)).toThrow(MailUndeliverableError);
  });

  test("suppression keeps its distinct message here too", () => {
    const error = (() => {
      try {
        applyInvitationSendPolicy(SUPPRESSED, CTX);
      } catch (e) {
        return e as MailUndeliverableError;
      }
    })();
    expect(error!.code).toBe(MAIL_SUPPRESSED_CODE);
  });
});

describe("a deduplicated send is still a send", () => {
  test("no call site treats `duplicate` as a failure", () => {
    const deduped: SendOutcome = { status: "sent", deduplicated: true };
    expect(() => applyVerificationSendPolicy(deduped, CTX)).not.toThrow();
    expect(() => applyResetSendPolicy(deduped, CTX)).not.toThrow();
    expect(() => applyInvitationSendPolicy(deduped, CTX)).not.toThrow();
    expect(warnings.length).toBe(0);
  });
});

describe("the console's mapping of an undeliverable error", () => {
  test("maps each stable code to its message", () => {
    expect(mailUndeliverableMessage({ code: MAIL_UNDELIVERABLE_CODE })).toContain(
      "typos",
    );
    expect(mailUndeliverableMessage({ code: MAIL_SUPPRESSED_CODE })?.toLowerCase()).toContain(
      "blocked",
    );
  });

  test("returns null for anything else, so the generic message still wins", () => {
    expect(mailUndeliverableMessage({ code: "USER_ALREADY_EXISTS" })).toBeNull();
    expect(mailUndeliverableMessage(null)).toBeNull();
    expect(mailUndeliverableMessage(undefined)).toBeNull();
    expect(mailUndeliverableMessage({})).toBeNull();
  });

  test("keys on the code, never on server error text", () => {
    expect(
      mailUndeliverableMessage({ message: "That email address cannot receive mail." }),
    ).toBeNull();
  });
});

/* ─── End-to-end through better-auth, with the provider's HTTP mocked ─────── */

async function createTestAuth(mail: CaptureMailSender | ReccadoMailSender) {
  const db = new Database(":memory:");
  const auth = createAuth({
    database: db,
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mail,
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db };
}

function signUp(auth: Awaited<ReturnType<typeof createTestAuth>>["auth"], email: string) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Ada" }),
    }),
  );
}

describe("no raw token ever leaves in a header", () => {
  test("the Idempotency-Key is the digest of the token in the message, not the token", async () => {
    const requests: { headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>,
      )) {
        headers[key.toLowerCase()] = value;
      }
      requests.push({ headers, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ status: "sent" }), { status: 200 });
    }) as typeof fetch;

    const { auth } = await createTestAuth(
      new ReccadoMailSender({
        RECCADO_API_KEY: "rc_test_key_123",
        RECCADO_ENDPOINT:
          "https://reccado.example.workers.dev/v1/mailboxes/mbx_42/transactional/messages",
      }),
    );
    const response = await signUp(auth, "ada@example.com");
    expect(response.status).toBe(200);
    expect(requests.length).toBe(1);

    const { headers, body } = requests[0]!;
    const variables = body.variables as Record<string, string>;
    const token = extractTokenFromUrl(variables.url!, "verify-email");
    expect(token).toBeTruthy();

    // The key is the SHA-256 of template:recipient:token …
    expect(headers["idempotency-key"]).toBe(
      await deriveIdempotencyKey("verify-email", "ada@example.com", token!),
    );
    // … so NO header carries the live token. The provider stores
    // `client_idempotency_key` deliberately and never purges it, so a raw token
    // there would be a permanent live credential in a third party's storage.
    for (const value of Object.values(headers)) {
      expect(value).not.toContain(token!);
    }
    // The action URL travels in the BODY, because it is the message itself —
    // that is the one place the token legitimately appears.
    expect(variables.url).toContain(token!);
  });
});

describe("what better-auth 1.7.2 does with a thrown send (documented gap)", () => {
  test("sign-up SWALLOWS the throw, so the undeliverable branch cannot fire there yet", async () => {
    // better-auth wraps the sign-up send in `runInBackgroundOrAwait`
    // (dist/context/create-context.mjs:214), which awaits inside a try/catch
    // and only LOGS a rejection. The same is true of create-invitation
    // (dist/plugins/organization/routes/crud-invites.mjs:226) and
    // forgot-password (dist/api/routes/password.mjs:83).
    //
    // This test pins that reality so it FAILS LOUDLY the day better-auth
    // propagates instead — at which point the console branch starts working
    // with no change on our side. See docs/auth-email-delivery.md.
    const { auth } = await createTestAuth(new CaptureMailSender(BOUNCED));
    const response = await signUp(auth, "bounced@example.com");
    expect(response.status).toBe(200);
  });

  test("POST /send-verification-email DOES propagate it", async () => {
    // The resend endpoint re-throws (dist/api/routes/email-verification.mjs:117),
    // so the policy is not dead code — this is where it surfaces today.
    const { auth, db } = await createTestAuth(new CaptureMailSender(BOUNCED));
    await signUp(auth, "resend@example.com");
    db.query('UPDATE user SET "emailVerified" = 0').run();
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "resend@example.com", callbackURL: "/" }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the three call sites send the declared variables", () => {
  test("verify-email sends name and url under a hashed key", async () => {
    const mail = new CaptureMailSender();
    const { auth } = await createTestAuth(mail);
    await signUp(auth, "vars@example.com");
    const sent = mail.sent[0]!;
    expect(sent.template).toBe("verify-email");
    expect(Object.keys(sent.variables).sort()).toEqual(["name", "url"]);
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reset-password sends name and url under a hashed key", async () => {
    const mail = new CaptureMailSender();
    const { auth, db } = await createTestAuth(mail);
    await signUp(auth, "reset@example.com");
    db.query('UPDATE user SET "emailVerified" = 1').run();
    mail.sent.length = 0;

    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "reset@example.com", redirectTo: "/" }),
      }),
    );
    expect(response.status).toBe(200);
    const sent = mail.sent[0]!;
    expect(sent.template).toBe("reset-password");
    expect(Object.keys(sent.variables).sort()).toEqual(["name", "url"]);
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    // Keyed on the reset token that is actually in the link.
    const token = extractTokenFromUrl(sent.variables.url!, "reset-password");
    expect(sent.idempotencyKey).toBe(
      await deriveIdempotencyKey("reset-password", "reset@example.com", token!),
    );
  });

  test("invite-member is keyed on the invitation id, which is why a resend must recreate", async () => {
    const mail = new CaptureMailSender();
    const { auth, db } = await createTestAuth(mail);
    await signUp(auth, "owner@example.com");
    db.query('UPDATE user SET "emailVerified" = 1').run();
    const signIn = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          email: "owner@example.com",
          password: "correct-horse-battery",
        }),
      }),
    );
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    const org = (await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: new Headers({ cookie }),
    })) as { id?: string };
    mail.sent.length = 0;

    const invitation = (await auth.api.createInvitation({
      body: { email: "invitee@example.com", role: "viewer", organizationId: org.id! },
      headers: new Headers({ cookie }),
    })) as { id?: string };

    const sent = mail.sent[0]!;
    expect(sent.template).toBe("invite-member");
    // The provider's declared set, read back from the mailbox on 2026-09-01 —
    // snake_case, `workspace` rather than the organization's name, `accept_url`
    // rather than `url`. Validation is exact in both directions, so this
    // assertion is the thing that catches a drift before a send does.
    expect(Object.keys(sent.variables).sort()).toEqual([
      "accept_url",
      "inviter_email",
      "inviter_name",
      "workspace",
    ]);
    expect(sent.idempotencyKey).toBe(
      await deriveIdempotencyKey("invite-member", "invitee@example.com", invitation.id!),
    );
    // THE REASON A FUTURE "RESEND INVITATION" MUST CANCEL-PLUS-RECREATE: reusing
    // the invitation id reproduces this exact key over an identical payload, so
    // the provider dedupes it and the mail silently never sends.
    expect(
      await deriveIdempotencyKey("invite-member", "invitee@example.com", invitation.id!),
    ).toBe(sent.idempotencyKey);
    expect(
      await deriveIdempotencyKey("invite-member", "invitee@example.com", "a-new-id"),
    ).not.toBe(sent.idempotencyKey);
  });
});
