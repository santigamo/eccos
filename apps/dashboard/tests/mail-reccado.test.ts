/**
 * reccado mail adapter tests (eccos-3ne).
 *
 * Pins the frozen provider contract: every documented status maps to exactly
 * one outcome or one throw, the request is shaped the way the contract
 * requires, and the Idempotency-Key is a digest rather than a live token.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deriveIdempotencyKey,
  extractTokenFromUrl,
  MailProviderError,
  TEMPLATE_VARIABLES,
  VERIFY_EMAIL_VARIABLES,
  RESET_PASSWORD_VARIABLES,
  INVITE_MEMBER_VARIABLES,
  ConsoleMailSender,
} from "../src/auth/mail";
import { ReccadoMailSender } from "../src/auth/mail-reccado";
import { createMailSenderFromEnv } from "../src/auth/config";

const ENV = {
  RECCADO_API_KEY: "rc_test_key_123",
  RECCADO_BASE_URL: "https://reccado.example.workers.dev",
  RECCADO_MAILBOX_ID: "mbx_42",
};

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: { template?: string; to?: string; variables?: Record<string, string> };
}

const captured: Captured[] = [];
const originalFetch = globalThis.fetch;

/** Answer the next send with one status + JSON envelope. */
function mockProvider(status: number, envelope: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    captured.push({
      url: String(input),
      method: init?.method,
      headers,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify(envelope), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function send(overrides: Partial<Parameters<ReccadoMailSender["sendTemplate"]>[0]> = {}) {
  const sender = new ReccadoMailSender(ENV);
  return sender.sendTemplate({
    template: "verify-email",
    to: "user@example.com",
    variables: { name: "Ada", url: "https://app.eccos.chat/verify-email?token=tok" },
    idempotencyKey: "a".repeat(64),
    ...overrides,
  });
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("configuration", () => {
  test("fails closed without an API key", () => {
    expect(() => new ReccadoMailSender({ ...ENV, RECCADO_API_KEY: "" })).toThrow(
      /RECCADO_API_KEY/,
    );
  });

  test("fails closed without a base URL — the origin is configuration, not a constant", () => {
    // The provider's custom domain is behind Cloudflare Access and answers only
    // on its workers.dev host today; a hardcoded origin would strand the
    // deployment the moment the other one becomes live.
    expect(() => new ReccadoMailSender({ ...ENV, RECCADO_BASE_URL: "" })).toThrow(
      /RECCADO_BASE_URL/,
    );
  });

  test("fails closed without a mailbox id", () => {
    expect(() => new ReccadoMailSender({ ...ENV, RECCADO_MAILBOX_ID: "" })).toThrow(
      /RECCADO_MAILBOX_ID/,
    );
  });

  test("no key configured selects the development console sender", () => {
    const sender = createMailSenderFromEnv({});
    expect(sender instanceof ConsoleMailSender).toBe(true);
  });

  test("a configured key selects the reccado sender", () => {
    expect(createMailSenderFromEnv(ENV) instanceof ReccadoMailSender).toBe(true);
  });
});

describe("request shape", () => {
  test("posts JSON to the mailbox transactional endpoint with the mandatory headers", async () => {
    mockProvider(200, { status: "sent", requestId: "req_1", providerMessageId: "m_1" });
    await send({ idempotencyKey: "b".repeat(64) });

    const request = captured[0]!;
    expect(request.url).toBe(
      "https://reccado.example.workers.dev/v1/mailboxes/mbx_42/transactional/messages",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${ENV.RECCADO_API_KEY}`);
    // MANDATORY — the provider answers 400 without it.
    expect(request.headers["idempotency-key"]).toBe("b".repeat(64));
    // Anything else is a 415.
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body.template).toBe("verify-email");
    expect(request.body.to).toBe("user@example.com");
  });

  test("a trailing slash on the base URL does not double up", async () => {
    mockProvider(200, { status: "sent" });
    await new ReccadoMailSender({
      ...ENV,
      RECCADO_BASE_URL: "https://reccado.example.workers.dev/",
    }).sendTemplate({
      template: "verify-email",
      to: "user@example.com",
      variables: { name: "Ada", url: "https://app.eccos.chat/verify-email?token=t" },
      idempotencyKey: "c".repeat(64),
    });
    expect(captured[0]!.url).not.toContain("//v1/");
  });
});

describe("status mapping", () => {
  test("200 sent is a send", async () => {
    mockProvider(200, { status: "sent", requestId: "r", providerMessageId: "m" });
    expect(await send()).toEqual({ status: "sent" });
  });

  test("200 duplicate is a send that did not re-send", async () => {
    mockProvider(200, { status: "duplicate", requestId: "r", providerMessageId: "m" });
    expect(await send()).toEqual({ status: "sent", deduplicated: true });
  });

  test("202 accepted is a send", async () => {
    mockProvider(202, { status: "accepted" });
    expect(await send()).toEqual({ status: "sent" });
  });

  test("502 permanent_failure is undeliverable", async () => {
    mockProvider(502, { status: "permanent_failure" });
    expect(await send()).toEqual({
      status: "undeliverable",
      reason: "permanent_failure",
    });
  });

  test("504 unknown is unresolved — and is never retried", async () => {
    mockProvider(504, { status: "unknown" });
    expect(await send()).toEqual({ status: "unresolved" });
    // TERMINAL: exactly one request left the Worker. A replay would return the
    // stored status without re-asking, and delivery events cannot resolve it
    // (they correlate by a provider message id that is null precisely here).
    expect(captured.length).toBe(1);
  });

  test("403 recipient_suppressed is undeliverable, not a thrown misconfiguration", async () => {
    mockProvider(403, { status: "recipient_suppressed" });
    expect(await send()).toEqual({
      status: "undeliverable",
      reason: "recipient_suppressed",
    });
  });

  test("a 200 with an unreadable body is still a send", async () => {
    globalThis.fetch = (async () =>
      new Response("not json", { status: 200 })) as typeof fetch;
    expect(await send()).toEqual({ status: "sent" });
  });
});

describe("statuses that throw — a bug here or an operational emergency", () => {
  const cases: [number, string, string][] = [
    [400, "idempotency_key_required", "idempotency_key_required"],
    [401, "missing_authorization", "missing_authorization"],
    [409, "idempotency_conflict", "idempotency_conflict"],
    [415, "unsupported_media_type", "unsupported_media_type"],
    [429, "quota_exceeded", "quota_exceeded"],
  ];

  for (const [status, providerStatus, kind] of cases) {
    test(`${status} ${providerStatus} throws (${kind})`, async () => {
      mockProvider(status, { status: providerStatus });
      const error = (await send().catch((e) => e)) as MailProviderError;
      expect(error).toBeInstanceOf(MailProviderError);
      expect(error.kind).toBe(kind);
      expect(error.httpStatus).toBe(status);
    });
  }

  // Every other 403 is a deployment that is wrong, not a message that failed.
  for (const providerStatus of [
    "invalid_api_key",
    "insufficient_scope",
    "key_expired",
    "key_revoked",
    "template_not_allowed",
    "template_not_found",
    "denied_by_policy",
    "test_key_not_allowed_in_production_send",
  ]) {
    test(`403 ${providerStatus} throws as a misconfiguration`, async () => {
      mockProvider(403, { status: providerStatus });
      const error = (await send().catch((e) => e)) as MailProviderError;
      expect(error).toBeInstanceOf(MailProviderError);
      expect(error.kind).toBe("misconfiguration");
      expect(error.providerStatus).toBe(providerStatus);
    });
  }

  test("403 quota_exceeded alarms as a quota failure, not a misconfiguration", async () => {
    mockProvider(403, { status: "quota_exceeded" });
    const error = (await send().catch((e) => e)) as MailProviderError;
    expect(error.kind).toBe("quota_exceeded");
  });

  test("an undefined status throws rather than being guessed at", async () => {
    mockProvider(500, { status: "kaboom" });
    const error = (await send().catch((e) => e)) as MailProviderError;
    expect(error.kind).toBe("unexpected_status");
  });
});

describe("variable sets are exact in both directions", () => {
  test("a missing declared placeholder is rejected before it reaches the provider", async () => {
    mockProvider(200, { status: "sent" });
    const error = (await send({ variables: { name: "Ada" } }).catch(
      (e) => e,
    )) as MailProviderError;
    expect(error).toBeInstanceOf(MailProviderError);
    expect(error.kind).toBe("contract_violation");
    expect(error.message).toContain("missing: url");
    // Never left the Worker: a local contract break is not the provider's problem.
    expect(captured.length).toBe(0);
  });

  test("an extra undeclared variable is rejected too", async () => {
    mockProvider(200, { status: "sent" });
    const error = (await send({
      variables: { name: "Ada", url: "https://app.eccos.chat/x", extra: "nope" },
    }).catch((e) => e)) as MailProviderError;
    expect(error.kind).toBe("contract_violation");
    expect(error.message).toContain("undeclared: extra");
    expect(captured.length).toBe(0);
  });

  test("the declared sets are registered one constant per template", () => {
    expect(TEMPLATE_VARIABLES["verify-email"]).toBe(VERIFY_EMAIL_VARIABLES);
    expect(TEMPLATE_VARIABLES["reset-password"]).toBe(RESET_PASSWORD_VARIABLES);
    expect(TEMPLATE_VARIABLES["invite-member"]).toBe(INVITE_MEMBER_VARIABLES);
    expect(Object.keys(TEMPLATE_VARIABLES).sort()).toEqual([
      "invite-member",
      "reset-password",
      "verify-email",
    ]);
  });
});

describe("idempotency key derivation", () => {
  const TOKEN = "verification-token-abc123";

  test("is a SHA-256 hex digest", async () => {
    const key = await deriveIdempotencyKey("verify-email", "user@example.com", TOKEN);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable for the same token — a framework retry replays and dedupes", async () => {
    const a = await deriveIdempotencyKey("verify-email", "user@example.com", TOKEN);
    const b = await deriveIdempotencyKey("verify-email", "user@example.com", TOKEN);
    expect(a).toBe(b);
  });

  test("differs for a different token — a user-initiated resend genuinely sends", async () => {
    const a = await deriveIdempotencyKey("verify-email", "user@example.com", TOKEN);
    const b = await deriveIdempotencyKey("verify-email", "user@example.com", `${TOKEN}!`);
    expect(a).not.toBe(b);
  });

  test("differs by recipient and by template", async () => {
    const base = await deriveIdempotencyKey("verify-email", "user@example.com", TOKEN);
    expect(
      await deriveIdempotencyKey("verify-email", "other@example.com", TOKEN),
    ).not.toBe(base);
    expect(
      await deriveIdempotencyKey("reset-password", "user@example.com", TOKEN),
    ).not.toBe(base);
  });

  test("never carries the raw token — the provider stores this key and never purges it", async () => {
    const key = await deriveIdempotencyKey("verify-email", "user@example.com", TOKEN);
    expect(key).not.toContain(TOKEN);
    expect(key).not.toBe(TOKEN);
    // Nor the recipient, nor the template name: it is a digest, not an encoding.
    expect(key).not.toContain("user@example.com");
    expect(key).not.toContain("verify-email");
  });
});

describe("token extraction from the URL better-auth builds", () => {
  test("verify-email carries the token in ?token=", () => {
    expect(
      extractTokenFromUrl(
        "https://app.eccos.chat/api/auth/verify-email?token=abc.def&callbackURL=%2F",
        "verify-email",
      ),
    ).toBe("abc.def");
  });

  test("reset-password carries the token as the last path segment", () => {
    expect(
      extractTokenFromUrl(
        "https://app.eccos.chat/api/auth/reset-password/tok_9?callbackURL=",
        "reset-password",
      ),
    ).toBe("tok_9");
  });

  test("a URL that does not match returns null so the caller falls back to the token field", () => {
    // Critically it must NOT return the URL: hashing the URL would key on a
    // string that contains the live token.
    expect(extractTokenFromUrl("https://app.eccos.chat/verify-email", "verify-email")).toBeNull();
    expect(extractTokenFromUrl("not a url", "verify-email")).toBeNull();
    expect(
      extractTokenFromUrl("https://app.eccos.chat/reset-password", "reset-password"),
    ).toBeNull();
  });
});
