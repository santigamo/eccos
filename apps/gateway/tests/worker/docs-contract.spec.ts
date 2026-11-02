/**
 * Contract tests for the public API docs (apps/docs). Every example, table row and code sample is
 * read from the markdown, so the suite fails when docs and code drift apart.
 * The parser side lives in tests/docs-events.test.ts.
 */
import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EccosGateway, backoffMs, withJitter } from "../../src/gateway";
import { getControlPlaneStub } from "../../src/control-plane-stub";
import { signPayload } from "@eccos/core/signature";
import { codeSpans, fences, jsonFences, quoted, tableRows } from "../docs-md";
import authMd from "../../../docs/src/content/docs/authentication.md?raw";
import dataMd from "../../../docs/src/content/docs/data-endpoints.md?raw";
import errorsMd from "../../../docs/src/content/docs/errors-and-rate-limits.md?raw";
import idempotencyMd from "../../../docs/src/content/docs/idempotency.md?raw";
import sendingMd from "../../../docs/src/content/docs/sending-messages.md?raw";
import webhooksMd from "../../../docs/src/content/docs/webhooks.md?raw";
import * as nodeSample from "../../../docs/src/content/docs/webhooks.md?ts-fence=0";
import * as webCryptoSample from "../../../docs/src/content/docs/webhooks.md?ts-fence=1";
import {
  bootstrapAccount,
  gatewayStub,
  holdAlarms,
  runAlarm,
  SUBSCRIBER_SECRET,
  SUBSCRIBER_URL,
  TEST_ACCOUNT_ID,
  TEST_WABA_ID,
} from "./helpers";

const MULTI = "WABA_MULTI";
const BSUID = sendingMd.match(/US\.\d+/)![0];
let apiKey = "";

beforeEach(async () => {
  apiKey = (await bootstrapAccount()).apiKey;
  await bootstrapAccount(TEST_ACCOUNT_ID, MULTI, [
    { phoneNumberId: "PN_A" },
    { phoneNumberId: "PN_B" },
  ]);
  await bootstrapAccount("other-account", "WABA_FOREIGN", [
    { phoneNumberId: "PN_FOREIGN" },
  ]);
  await runInDurableObject(getControlPlaneStub(env), (cp) =>
    cp.registerWaba({
      accountId: TEST_ACCOUNT_ID,
      wabaId: "WABA_PENDING",
      metaAccessToken: "t",
      provisioningStatus: "pending",
      phones: [],
    }),
  );
  await holdAlarms();
});

afterEach(async () => {
  delete (env as { SEND_RATE_LIMITER?: RateLimit }).SEND_RATE_LIMITER;
  vi.restoreAllMocks();
  await reset();
});

// --- helpers -----------------------------------------------------------------

interface Call {
  path: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

function call({ path, method = "POST", headers = {}, body }: Call) {
  const merged: Record<string, string | undefined> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...headers,
  };
  return exports.default.fetch(`http://example.com${path}`, {
    method,
    headers: Object.fromEntries(
      Object.entries(merged).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

const MSG = `/v1/wabas/${TEST_WABA_ID}/messages`;
const text = (to = "34600000000") => ({
  to,
  type: "text",
  text: { body: "Hello" },
});
const send = (body: unknown = text(), headers?: Call["headers"], path = MSG) =>
  call({ path, body, headers });

type MetaAnswer = () => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const accepted = (id = "wamid.TEST") => json({ messages: [{ id }] });

/** Stubs Meta for the whole test; every request it receives is recorded in `.mock.calls`. */
function mockMeta(answer: MetaAnswer = () => accepted()) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
}

const metaRequest = (spy: ReturnType<typeof mockMeta>, n = 0) => {
  const [url, init] = spy.mock.calls[n]!;
  return {
    url: String(url),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
};

const limiter = (success: boolean) => {
  const limit = vi.fn(async () => ({ success }));
  (env as { SEND_RATE_LIMITER?: RateLimit }).SEND_RATE_LIMITER = { limit };
  return limit;
};

const statusOf = (cell: string) => Number(cell.match(/\b\d{3}\b/)![0]);

/** `422 {"ok":false,...}` -> [422, {...}]; `...` and <placeholders> become null. */
function statusAndJson(span: string): [number, Record<string, unknown>] {
  const [, status, rest] = span.match(/^(\d{3}) (.*)$/)!;
  return [Number(status), JSON.parse(rest!.replace(/\.\.\.|<[^>]+>/g, "null"))];
}

// --- authentication.md ---------------------------------------------------------

describe("authentication.md", () => {
  const [unauthorizedSpec] = fences(authMd).filter((f) =>
    /^\d{3} /.test(f.code),
  );
  const [unauthorizedStatus, unauthorizedBody] = statusAndJson(
    unauthorizedSpec!.code.trim(),
  );
  const probe = (headers: Call["headers"]) =>
    call({ path: `/v1/wabas/${TEST_WABA_ID}/export`, method: "GET", headers });

  it("documents both header forms, and both work", async () => {
    const headerBlock = fences(authMd)[0]!.code;
    expect(headerBlock).toContain("Authorization: Bearer ek_");
    expect(headerBlock).toContain("X-API-Key: ek_");
    expect((await probe({ authorization: `Bearer ${apiKey}` })).status).toBe(
      200,
    );
    expect(
      (await probe({ authorization: undefined, "x-api-key": apiKey })).status,
    ).toBe(200);
  });

  it("uses Authorization: Bearer when both are present, and Bearer is case-sensitive", async () => {
    expect(
      (
        await probe({
          authorization: `Bearer ${apiKey}`,
          "x-api-key": "ek_wrong",
        })
      ).status,
    ).toBe(200);
    expect(
      (await probe({ authorization: "Bearer ek_wrong", "x-api-key": apiKey }))
        .status,
    ).toBe(401);
    expect((await probe({ authorization: `bearer ${apiKey}` })).status).toBe(
      401,
    );
  });

  it("answers a missing or unknown key with the documented 401 body", async () => {
    for (const headers of [
      { authorization: undefined },
      { authorization: "Bearer ek_unknown" },
    ]) {
      const res = await probe(headers);
      expect(res.status).toBe(unauthorizedStatus);
      expect(await res.json()).toEqual(unauthorizedBody);
    }
  });
});

// --- errors-and-rate-limits.md ---------------------------------------------------

describe("errors-and-rate-limits.md error table", () => {
  const rows = tableRows(errorsMd, "| Status");
  const metaError = jsonFences(errorsMd)[0] as { ok: false; error: unknown };

  const drivers: Record<string, () => Promise<Response>> = {
    "Body is not valid JSON": () => send("{nope"),
    "Bad recipient": () => send(text("12")),
    "Several numbers and none chosen": () =>
      send(text(), undefined, `/v1/wabas/${MULTI}/messages`),
    "URL and body name different numbers": () =>
      send(
        { ...text(), phone_number_id: "PN_B" },
        undefined,
        `/v1/wabas/${MULTI}/phones/PN_A/messages`,
      ),
    "Malformed `Idempotency-Key`": () =>
      send(text(), { "idempotency-key": "a b" }),
    "Missing, unknown or revoked key": () =>
      send(text(), { authorization: undefined }),
    "WABA unknown, not yours, or not active": () =>
      send(text(), undefined, "/v1/wabas/WABA_NOPE/messages"),
    "Number not in this WABA": () =>
      send(
        text(),
        undefined,
        `/v1/wabas/${TEST_WABA_ID}/phones/PN_NOPE/messages`,
      ),
    "Idempotency key in progress or unknown outcome": async () => {
      mockMeta(() => json({}, 503));
      await send(text(), { "idempotency-key": "k" });
      return send(text(), { "idempotency-key": "k" });
    },
    "Idempotency key reused with a different body": async () => {
      mockMeta();
      await send(text(), { "idempotency-key": "k" });
      return send(text("34600000099"), { "idempotency-key": "k" });
    },
    "Rate limit": async () => {
      limiter(false);
      return send();
    },
    "Malformed WABA id in the URL": () =>
      send(text(), undefined, "/v1/wabas/bad%21id/messages"),
    "Meta did not accept the message": async () => {
      mockMeta(() => json(metaError.error, 400));
      return send();
    },
  };

  it("has a driver for every row, and no stale driver", () => {
    expect(rows.map((r) => r[1]!).sort()).toEqual(Object.keys(drivers).sort());
  });

  for (const row of rows) {
    const [status, when, errorCell] = [statusOf(row[0]!), row[1]!, row[2]!];
    it(`${status} ${when}`, async () => {
      const res = await drivers[when]!();
      expect(res.status).toBe(status);
      const body = (await res.json()) as { ok: boolean; error: unknown };
      expect(body.ok).toBe(false);
      const [literal] = codeSpans(errorCell);
      if (literal?.startsWith('"'))
        expect(body.error).toBe(JSON.parse(literal));
      if (status === 409)
        expect(body.error).toBe(
          JSON.parse(
            codeSpans(tableRows(idempotencyMd, "| Situation")[2]![1]!)[1]!,
          ),
        );
      if (status === 502) expect(body).toEqual(metaError);
    });
  }

  it("404 also covers a WABA of another account and a WABA that is not active", async () => {
    const expected = quoted(
      rows.find((r) => r[0] === "404" && r[1]!.startsWith("WABA unknown"))![2]!,
    );
    for (const waba of ["WABA_FOREIGN", "WABA_PENDING"]) {
      const res = await send(text(), undefined, `/v1/wabas/${waba}/messages`);
      expect(res.status, waba).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: expected });
    }
  });

  it("unknown outcome: error is Meta's JSON, a string, or null; a 2xx without a message id is unknown too", async () => {
    const outcome = async (answer: MetaAnswer) => {
      mockMeta(answer);
      const res = await send();
      expect(res.status).toBe(502);
      return (await res.json()) as Record<string, unknown>;
    };
    expect(await outcome(() => json({ error: { code: 1 } }, 503))).toEqual({
      ok: false,
      outcome: "unknown",
      error: { error: { code: 1 } },
    });
    expect(
      await outcome(() => Promise.reject(new Error("timeout"))),
    ).toMatchObject({ ok: false, outcome: "unknown", error: "timeout" });
    expect(
      await outcome(() => new Response("bad gateway", { status: 502 })),
    ).toEqual({ ok: false, outcome: "unknown", error: null });
    expect(await outcome(() => json({ contacts: [] }))).toMatchObject({
      ok: false,
      outcome: "unknown",
    });
  });
});

describe("errors-and-rate-limits.md rate limit", () => {
  it("answers the documented 429 body and sends no Retry-After", async () => {
    const [, body] = statusAndJson(
      `429 ${errorsMd.match(/`(\{"ok":false,"error":"rate limited"\})`/)![1]}`,
    );
    const meta = mockMeta();
    limiter(false);
    const res = await send();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(meta).not.toHaveBeenCalled();
  });

  it("counts validated sends (replays and Meta rejections included) and not 400/404/500", async () => {
    const limit = limiter(true);
    mockMeta(() => json({ error: { code: 100 } }, 400));
    const outcomes = [
      await send("{nope"),
      await send(text(), undefined, "/v1/wabas/WABA_NOPE/messages"),
      await send(text(), undefined, "/v1/wabas/bad%21id/messages"),
    ];
    expect(outcomes.map((r) => r.status)).toEqual([400, 404, 500]);
    expect(limit).not.toHaveBeenCalled();
    await send(text(), { "idempotency-key": "k" });
    await send(text(), { "idempotency-key": "k" });
    expect(limit).toHaveBeenCalledTimes(2);
  });
});

// --- idempotency.md --------------------------------------------------------------

describe("idempotency.md table", () => {
  const rows = tableRows(idempotencyMd, "| Situation");
  const key = { "idempotency-key": "doc-key" };
  const scenarios: Array<[RegExp, () => Promise<void>]> = [
    [
      /^First use/,
      async () => {
        const meta = mockMeta();
        const res = await send(text(), key);
        expect(res.status).toBe(200);
        expect(meta).toHaveBeenCalledTimes(1);
      },
    ],
    [
      /^Same key and body, result already stored/,
      async () => {
        const [replayed, stored] = codeSpans(rows[1]![1]!).map(Number);
        const meta = mockMeta();
        const first = await send(text(), key);
        const second = await send(text(), key);
        expect([first.status, second.status]).toEqual([replayed, replayed]);
        expect(await second.json()).toEqual(await first.json());
        expect(meta).toHaveBeenCalledTimes(1);
        // the stored 502 replays with its status
        mockMeta(() => json({ error: { code: 100 } }, 400));
        const failed = await send(text(), { "idempotency-key": "other" });
        expect(failed.status).toBe(stored);
        expect(
          (await send(text(), { "idempotency-key": "other" })).status,
        ).toBe(stored);
      },
    ],
    [
      /^Same key while the first request is still running/,
      async () => {
        const [status, message] = codeSpans(rows[2]![1]!);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const meta = mockMeta(async () => {
          await gate;
          return accepted();
        });
        const first = send(text(), key);
        await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));
        const second = await send(text(), key);
        expect(second.status).toBe(Number(status));
        expect(await second.json()).toEqual({
          ok: false,
          error: JSON.parse(message!),
        });
        release();
        await first;
      },
    ],
    [
      /^Same key, different body or number/,
      async () => {
        const [expectedStatus, expectedBody] = statusAndJson(
          codeSpans(rows[3]![1]!)[0]!,
        );
        mockMeta();
        await send(text(), key);
        const body = await send(text("34600000099"), key);
        expect(body.status).toBe(expectedStatus);
        expect(await body.json()).toEqual(expectedBody);
        const viaPhone = (phone: string) =>
          send(text(), key, `/v1/wabas/${MULTI}/phones/${phone}/messages`);
        expect((await viaPhone("PN_A")).status).toBe(200);
        const number = await viaPhone("PN_B");
        expect(number.status).toBe(expectedStatus);
      },
    ],
    [
      /^Meta unreachable, timed out, or answered 5xx/,
      async () => {
        const [expectedStatus, expectedBody] = statusAndJson(
          codeSpans(rows[4]![1]!)[0]!,
        );
        for (const answer of [
          () => Promise.reject(new Error("timeout")),
          () => json({}, 503),
        ]) {
          await reset();
          await beforeEachSetup();
          const meta = mockMeta(answer);
          const res = await send(text(), key);
          const body = (await res.json()) as Record<string, unknown>;
          expect(res.status).toBe(expectedStatus);
          expect(body).toMatchObject({
            ok: expectedBody.ok,
            outcome: expectedBody.outcome,
          });
          expect(Object.keys(body)).toContain("error");
          expect((await send(text(), key)).status, "retries get 409").toBe(409);
          expect(meta).toHaveBeenCalledTimes(1);
          vi.restoreAllMocks();
        }
      },
    ],
    [
      /^Meta rejected the message \(4xx\)/,
      async () => {
        const [expectedStatus, expectedBody] = statusAndJson(
          codeSpans(rows[5]![1]!)[0]!,
        );
        const meta = mockMeta(() => json({ error: { code: 100 } }, 400));
        const first = await send(text(), key);
        expect(first.status).toBe(expectedStatus);
        expect(await first.json()).toEqual({
          ...expectedBody,
          error: { error: { code: 100 } },
        });
        const second = await send(text(), key);
        expect(second.status).toBe(expectedStatus);
        expect(meta).toHaveBeenCalledTimes(1);
      },
    ],
  ];

  async function beforeEachSetup() {
    apiKey = (await bootstrapAccount()).apiKey;
    await holdAlarms();
  }

  it("has a scenario for every row, in order", () => {
    expect(rows).toHaveLength(scenarios.length);
    for (const [i, [match]] of scenarios.entries())
      expect(rows[i]![0], `row ${i}`).toMatch(match);
  });

  for (const [i, [, run]] of scenarios.entries()) it(`row ${i + 1}`, run);
});

// --- sending-messages.md ---------------------------------------------------------

describe("sending-messages.md", () => {
  const [success, template] = jsonFences(sendingMd);
  const curlBody = JSON.parse(
    fences(sendingMd)
      .find((f) => f.lang === "bash")!
      .code.match(/-d '(.*)'/)![1]!,
  );

  it("answers the documented success shape with Meta's message id", async () => {
    const id = (success!.messages as Array<{ id: string }>)[0]!.id;
    mockMeta(() => accepted(id));
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(success);
  });

  it.each([
    ["text (curl)", curlBody],
    ["template", template],
  ])(
    "forwards the documented %s body to Meta unchanged but for messaging_product",
    async (_, body) => {
      const meta = mockMeta();
      expect((await send(body)).status).toBe(200);
      const sent = metaRequest(meta);
      expect(sent.url).toContain("/PNID1/messages");
      expect(sent.body).toEqual({
        messaging_product: "whatsapp",
        ...(body as object),
      });
    },
  );

  it("strips phone_number_id and uses it to pick the number", async () => {
    const meta = mockMeta();
    expect(
      (
        await send(
          { ...text(), phone_number_id: "PN_B" },
          undefined,
          `/v1/wabas/${MULTI}/messages`,
        )
      ).status,
    ).toBe(200);
    const sent = metaRequest(meta);
    expect(sent.url).toContain("/PN_B/messages");
    expect(sent.body).not.toHaveProperty("phone_number_id");
    expect(
      (await send(text(), undefined, `/v1/wabas/${MULTI}/phones/PN_A/messages`))
        .status,
    ).toBe(200);
    expect(metaRequest(meta, 1).url).toContain("/PN_A/messages");
  });

  it("accepts a leading +, separators inside, and 5 to 15 digits; rejects a leading ( and other shapes", async () => {
    mockMeta();
    for (const to of [
      "+34600000000",
      "34 600.000-000",
      "+34 (600) 000 000",
      "12345",
      "123456789012345",
    ]) {
      expect((await send(text(to))).status, to).toBe(200);
    }
    for (const to of [
      "(34)600000000",
      "1234",
      "1234567890123456",
      "abc",
      "+",
    ]) {
      expect((await send(text(to))).status, to).toBe(400);
    }
  });

  it("sends a BSUID in Meta's recipient field, given as to or as recipient", async () => {
    const meta = mockMeta();
    expect(
      (await send({ type: "text", text: { body: "hi" }, recipient: BSUID }))
        .status,
    ).toBe(200);
    expect((await send(text(BSUID))).status).toBe(200);
    for (const n of [0, 1]) {
      const { body } = metaRequest(meta, n);
      expect(body.recipient).toBe(BSUID);
      expect(body).not.toHaveProperty("to");
    }
  });

  it("returns Meta's templates response unchanged and clamps limit to 1..1000 (default 100)", async () => {
    const page = {
      data: [{ name: "hello_world", language: "en_US", status: "APPROVED" }],
      paging: {},
    };
    const meta = mockMeta(() => json(page));
    const get = (query = "") =>
      call({
        path: `/v1/wabas/${TEST_WABA_ID}/templates${query}`,
        method: "GET",
      });
    const res = await get();
    expect(await res.json()).toEqual(page);
    await get("?limit=5000");
    await get("?limit=0");
    expect(
      meta.mock.calls.map(([url]) => String(url).match(/limit=(\d+)/)![1]),
    ).toEqual(["100", "1000", "1"]);
    mockMeta(() => json({ error: { code: 190 } }, 401));
    const failed = await get();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false });
  });
});

// --- webhooks.md -----------------------------------------------------------------

describe("webhooks.md", () => {
  let forwards: Array<{ init: RequestInit; body: string }> = [];
  let subscriber: () => Response = () => new Response("ok");

  beforeEach(async () => {
    forwards = [];
    subscriber = () => new Response("ok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) !== SUBSCRIBER_URL)
        return new Response("nope", { status: 404 });
      forwards.push({ init: init!, body: String(init?.body) });
      return subscriber();
    });
    await gatewayStub().saveConfig({
      SUBSCRIBER_WEBHOOK_URL: SUBSCRIBER_URL,
      SUBSCRIBER_SECRET: SUBSCRIBER_SECRET,
    });
  });

  async function receiveFromMeta() {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: TEST_WABA_ID,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PNID1" },
                statuses: [
                  {
                    id: "wamid.OUT",
                    status: "delivered",
                    timestamp: "1700000000",
                  },
                ],
                messages: [
                  {
                    from: "34600000000",
                    id: "wamid.IN",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hi" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const res = await exports.default.fetch(
      "http://example.com/webhooks/meta",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": await signPayload(body, env.META_APP_SECRET),
        },
        body,
      },
    );
    expect(res.status).toBe(200);
  }

  const sha256Hex = async (s: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  it("forwards the documented request: method, headers and { events } body", async () => {
    const requestBlock = fences(webhooksMd).find((f) =>
      f.code.startsWith("POST <your URL>"),
    )!.code;
    const documentedHeaders = [...requestBlock.matchAll(/^([a-z-]+): /gm)].map(
      (m) => m[1]!,
    );
    await receiveFromMeta();
    await runAlarm();
    expect(forwards).toHaveLength(1);
    const { init, body } = forwards[0]!;
    expect(init.method).toBe(requestBlock.split(" ")[0]);
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual([...documentedHeaders].sort());
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-eccos-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers.get("x-webhook-event")).toBe(
      JSON.parse(body).events[0].type,
    );
    expect(headers.get("x-idempotency-key")).toBe(await sha256Hex(body));
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed)).toEqual(["events"]);
    expect(parsed.events.length).toBeGreaterThan(1);
  });

  it("omits x-eccos-signature when no signing secret is set", async () => {
    await gatewayStub().saveConfig({ SUBSCRIBER_SECRET: "" });
    await receiveFromMeta();
    await runAlarm();
    expect(
      new Headers(forwards[0]!.init.headers).has("x-eccos-signature"),
    ).toBe(false);
  });

  describe("signature verification samples", () => {
    const tamper = (body: string) => body.replace("hi", "ho");
    const malformed = [
      undefined,
      "",
      "sha256=",
      "sha256=xyz",
      "md5=abc",
      `sha256=${"G".repeat(64)}`,
      `sha256=${"a".repeat(63)}`,
      `SHA256=${"a".repeat(64)}`,
    ];

    async function forwarded() {
      await receiveFromMeta();
      await runAlarm();
      const { init, body } = forwards[0]!;
      return {
        body,
        header: new Headers(init.headers).get("x-eccos-signature")!,
      };
    }

    it("the Node sample accepts the real forward, rejects tampering, never throws on a bad header", async () => {
      const { body, header } = await forwarded();
      expect(
        nodeSample.verifyEccos(Buffer.from(body), header, SUBSCRIBER_SECRET),
      ).toBe(true);
      expect(
        nodeSample.verifyEccos(
          Buffer.from(tamper(body)),
          header,
          SUBSCRIBER_SECRET,
        ),
      ).toBe(false);
      expect(
        nodeSample.verifyEccos(Buffer.from(body), header, "wrong-secret"),
      ).toBe(false);
      for (const bad of malformed)
        expect(
          nodeSample.verifyEccos(Buffer.from(body), bad, SUBSCRIBER_SECRET),
          String(bad),
        ).toBe(false);
    });

    it("the WebCrypto sample accepts the real forward, rejects tampering, never throws on a bad header", async () => {
      const { body, header } = await forwarded();
      expect(
        await webCryptoSample.verifyEccos(body, header, SUBSCRIBER_SECRET),
      ).toBe(true);
      expect(
        await webCryptoSample.verifyEccos(
          tamper(body),
          header,
          SUBSCRIBER_SECRET,
        ),
      ).toBe(false);
      expect(
        await webCryptoSample.verifyEccos(body, header, "wrong-secret"),
      ).toBe(false);
      for (const bad of malformed)
        expect(
          await webCryptoSample.verifyEccos(
            body,
            bad ?? null,
            SUBSCRIBER_SECRET,
          ),
          String(bad),
        ).toBe(false);
    });
  });

  describe("retries", () => {
    const runs = tableRows(webhooksMd, "| Attempt")[0]!;
    const documentedDelays = runs.slice(2).map((cell) => {
      const [, n, unit] = cell.match(/~(\d+) (s|min)/)!;
      return { value: Number(n), unit: unit === "s" ? 1000 : 60_000 };
    });
    const attempts = Number(webhooksMd.match(/There are (\d+) attempts/)![1]);

    it("backoffMs matches the documented schedule, with +/-10% jitter", () => {
      expect(documentedDelays).toHaveLength(attempts - 1);
      for (const [i, { value, unit }] of documentedDelays.entries()) {
        expect(Math.round(backoffMs(i + 1) / unit), `attempt ${i + 1}`).toBe(
          value,
        );
      }
      expect(backoffMs(1)).toBe(5000 * 5 ** 0);
      expect(backoffMs(20)).toBe(3_600_000);
      expect(withJitter(1000, () => 0)).toBe(900);
      expect(withJitter(1000, () => 1)).toBe(1100);
    });

    it("a failing subscriber gets the documented number of attempts, then the batch is marked failed", async () => {
      subscriber = () => new Response("down", { status: 500 });
      await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
        (
          instance as unknown as { env: { FORWARD_MAX_ATTEMPTS: string } }
        ).env.FORWARD_MAX_ATTEMPTS = "";
      });
      await receiveFromMeta();
      for (let attempt = 1; attempt <= attempts + 2; attempt++) {
        await runAlarm();
        await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
          const row = instance.sql
            .exec("SELECT status, attempts, next_attempt_at FROM deliveries")
            .toArray()[0]!;
          if (attempt < attempts) {
            const wait = Number(row.next_attempt_at) - Date.now();
            expect(row.status).toBe("pending");
            expect(wait).toBeGreaterThan(backoffMs(attempt) * 0.85);
            expect(wait).toBeLessThanOrEqual(backoffMs(attempt) * 1.1);
          }
          instance.sql.exec(
            "UPDATE deliveries SET next_attempt_at = 0 WHERE status = 'pending'",
          );
        });
      }
      expect(forwards).toHaveLength(attempts);
      await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
        expect(
          instance.sql.exec("SELECT status FROM deliveries").toArray()[0]!
            .status,
        ).toBe("failed");
      });
    });

    it("counts a redirect as a failure and does not follow it", async () => {
      subscriber = () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.test/" },
        });
      await receiveFromMeta();
      await runAlarm();
      expect(forwards).toHaveLength(1);
      await runInDurableObject(gatewayStub(), (instance: EccosGateway) => {
        expect(
          instance.sql
            .exec("SELECT attempts, status FROM deliveries")
            .toArray()[0],
        ).toMatchObject({ attempts: 1, status: "pending" });
      });
    });
  });
});

// --- data-endpoints.md -----------------------------------------------------------

describe("data-endpoints.md", () => {
  const [erasureExample] = jsonFences(dataMd) as Array<{
    ok: true;
    phone: string;
    counts: Record<string, number>;
  }>;
  const erasePath = `/v1/wabas/${TEST_WABA_ID}/privacy/erasure`;

  it("GET /health needs no authentication and returns { ok: true, ... }", async () => {
    const res = await exports.default.fetch("http://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("the export answers { ok: true, data } with the documented collections", async () => {
    const res = await call({
      path: `/v1/wabas/${TEST_WABA_ID}/export`,
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(Object.keys(body).sort()).toEqual(["data", "ok"]);
    expect(body.ok).toBe(true);
    const paragraph = dataMd.slice(
      dataMd.indexOf("**Export**"),
      dataMd.indexOf("**Erasure**"),
    );
    const documented = codeSpans(paragraph).filter((s) =>
      /^[a-zA-Z]+$/.test(s),
    );
    expect(documented.length).toBeGreaterThanOrEqual(5);
    for (const collection of documented)
      expect(body.data, collection).toHaveProperty(collection);
  });

  it("erasure answers the documented shape and counts keys, echoing the phone as digits", async () => {
    const res = await call({
      path: erasePath,
      body: { phone: "+34 600-000-000" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof erasureExample;
    expect(Object.keys(body).sort()).toEqual(
      Object.keys(erasureExample!).sort(),
    );
    expect(body.phone).toBe(erasureExample!.phone);
    expect(Object.keys(body.counts).sort()).toEqual(
      Object.keys(erasureExample!.counts).sort(),
    );
    for (const value of Object.values(body.counts))
      expect(typeof value).toBe("number");
  });

  it("erasure errors: 400 for a missing or invalid phone, 404 for an unknown WABA, 503 when it did not finish", async () => {
    const errors = dataMd.match(/Errors: (.*)$/s)![1]!;
    const documented = Object.fromEntries(
      [...errors.matchAll(/`(\d{3})`/g)].map((m) => [m[1], true]),
    );
    expect(Object.keys(documented)).toEqual(["400", "404", "503"]);
    for (const body of [{}, { phone: "" }, { phone: 5 }, { phone: "1234" }]) {
      expect(
        (await call({ path: erasePath, body })).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      (
        await call({
          path: "/v1/wabas/WABA_NOPE/privacy/erasure",
          body: { phone: "34600000000" },
        })
      ).status,
    ).toBe(404);
    vi.spyOn(EccosGateway.prototype, "eraseByPhone").mockRejectedValueOnce(
      new Error("storage reset"),
    );
    expect(
      (await call({ path: erasePath, body: { phone: "34600000000" } })).status,
    ).toBe(503);
    expect(
      (await call({ path: erasePath, body: { phone: "34600000000" } })).status,
      "repeating the same request works",
    ).toBe(200);
  });
});
