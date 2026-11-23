import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The console and the gateway must agree on every template request: the
 * gateway refuses what the console refuses, with the same message, and what
 * the console forwards passes the gateway unchanged. The gateway is where the
 * rules are enforced for every caller; the console runs the same core rules
 * first so the operator sees a refusal without a round trip.
 *
 * A seeded random corpus plus a sweep of every single and paired field
 * variation of a valid request, from the differential harness that proved the
 * move of these rules into @eccos/core (#113).
 */

installServerFnMocks({ env: {} });
const consoleSide = await import("../src/server/gateway");
const gatewaySide = await import("../../gateway/src/template-requests");

/** Fields the console owns around the template rules; the gateway checks them elsewhere. */
const CONSOLE_FIELDS = ["wabaId", "phoneNumberId", "to", "idempotencyKey"];
/** Refusals of those fields, which only the console applies at this step. */
const CONSOLE_ONLY = new Set(["wabaId is required", "phoneNumberId is required"]);
/** The two bounds only the gateway applies, on input the console accepts, and when each applies. */
const GATEWAY_ONLY: Record<string, (accepted: Record<string, any>) => boolean> = {
  [gatewaySide.BUTTON_URL_TOO_LONG]: (accepted) => accepted.buttons?.some((button: { url: string }) => button.url.length > 2000),
  [gatewaySide.HEADER_LINK_WHITESPACE]: (accepted) => /\s/.test(accepted.headerMedia?.link ?? ""),
};

let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}
const int = (n: number) => Math.floor(rnd() * n);
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
const chance = (p: number) => rnd() < p;

const ABSENT = Symbol("absent");
const good = <T>(valid: readonly T[], all: readonly T[]): T => (chance(0.85) ? pick(valid) : pick(all));
const VN = ["hello_world", "order_update", "a", " hello ", "x_1_y", "a".repeat(512)];
const VL = ["en", "es", "en_US", "pt_BR", " en ", "fil"];
const VI = ["123", " 123 ", "0".repeat(32)];
const VP = ["Ada", " Ada ", "✅ ok", "naïve", "a  b", "x".repeat(1024), "{{1}}", " x"];
const VU = [
  "https://example.com",
  "https://ex.com/a?t={{1}}",
  "https://example.com/{{1}}",
  " https://example.com/x.png ",
  "HTTPS://EXAMPLE.COM/A",
  "http://example.com",
  "https://例え.jp/画像.png",
  `https://e.com/${"a".repeat(1986)}`,
  `https://e.com/${"a".repeat(1987)}`,
];
const junk: unknown[] = [undefined, null, 0, 1, -1, 1.5, Number.NaN, true, false, [], {}, ["a"], { a: 1 }, "", " "];
const names = ["hello_world", "a".repeat(512), "a".repeat(513), " hello ", "Hello", "hello-world", "héllo", "hello world", "123", "hello\n", "", "   "];
const langs = ["en", "es", "en_US", "pt_BR", "EN", "eng", "e", "en_us", " en ", "en-US", "zh_HANS", "fil", "", "\nen"];
const ids = ["123", " 123 ", "0".repeat(32), "1".repeat(33), "12a", "-1", "1e3", "", "١٢٣", "123\n"];
const urls = [
  "https://example.com",
  "http://example.com",
  "https://u:p@example.com",
  "https://u@example.com",
  "https://:p@x.com",
  "ftp://x.com/a",
  "data:image/png;base64,AAAA",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "HTTPS://EXAMPLE.COM/A",
  "https://example.com/{{1}}",
  "https://ex.com/a?t={{1}}",
  " https://example.com/x.png ",
  "https://example.com/a b.png",
  `https://${"a".repeat(2040)}.com`,
  "https:/x",
  "https://",
  "https://例え.jp/画像.png",
  "https://example.com/a\nb",
  "https://example.com/a\tb",
  "https://[::1]/x",
  `https://e.com/${"a".repeat(1986)}`,
  `https://e.com/${"a".repeat(1987)}`,
  "//example.com",
  "example.com",
  "https://ex.com/{{",
  "",
  "   ",
];
const params = ["Ada", " Ada ", "", " ", "\t", "\n", "a\nb", "a\tb", "x".repeat(1024), "x".repeat(1025), "✅ ok", "{{1}}", "\u00a0", "ok\r"];
const placeholder = () => pick(["{{1}}", "{{2}}", "{{3}}", "{{ 1 }}", "{{01}}", "{{0}}", "{{name}}", "{{", "}}", "{{4}}", "{{30}}", "{{31}}"]);

function body(): string {
  if (chance(0.1)) {
    return pick(["", " ", "\n", "x".repeat(1024), "x".repeat(1025), "Welcome!", Array.from({ length: 31 }, (_, i) => `{{${i + 1}}}`).join(" ")]);
  }
  const parts: string[] = [];
  for (let i = int(6); i > 0; i--) parts.push(chance(0.5) ? placeholder() : pick(["Hi", " order ", "\n", "\t", "✅", "{", "ref", "  "]));
  if (chance(0.6)) for (let i = 1, n = int(5); i <= n; i++) parts.push(` {{${i}}}`);
  return parts.join("");
}
const val = (gen: () => unknown, pJunk = 0.03): unknown => (chance(pJunk) ? pick(junk) : gen());
const opt = (gen: () => unknown, pAbsent = 0.1) => (chance(pAbsent) ? ABSENT : gen());
function arr(gen: () => unknown, max: number): unknown {
  if (chance(0.15)) return ABSENT;
  if (chance(0.06)) return pick(junk);
  return Array.from({ length: int(max + 1) }, gen);
}
function rec(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== ABSENT) out[k] = v;
  if (chance(0.05)) out[pick(["extra", "headerText"])] = pick(junk);
  return out;
}

function sendInput(): unknown {
  if (chance(0.01)) return pick(junk);
  return rec({
    wabaId: "waba_1",
    phoneNumberId: "123456",
    to: "34600111222",
    templateName: opt(() => val(() => good(VN, names)), 0.03),
    languageCode: opt(() => val(() => good(VL, langs)), 0.03),
    bodyParams: arr(() => val(() => good(VP, params)), 32),
    buttonParams: arr(
      () =>
        chance(0.1)
          ? pick(junk)
          : rec({ index: opt(() => pick([0, 1, 2, 9, 10, -1, 1.5, "1", null])), text: opt(() => val(() => good(VP, params))) }),
      4,
    ),
    headerMedia: chance(0.4)
      ? ABSENT
      : chance(0.1)
        ? pick(junk)
        : rec({
            format: opt(() => val(() => pick(["image", "video", "document", "IMAGE", "location", "audio"]))),
            link: opt(() => val(() => good(VU, urls))),
          }),
  });
}
function button(): unknown {
  if (chance(0.08)) return pick(junk);
  return rec({
    text: opt(() => val(() => pick(["Track", " Track ", "", " ", "x".repeat(25), "x".repeat(26), "a\nb", "✅"]))),
    url: opt(() => val(() => good(VU, urls))),
    exampleUrl: opt(() => val(() => good(VU, urls)), 0.5),
  });
}
function content(): Record<string, unknown> {
  const bodyText = chance(0.05) ? pick(junk) : body();
  const count = typeof bodyText === "string" ? (bodyText.match(/\{\{/g) ?? []).length : 0;
  return {
    bodyText: chance(0.02) ? ABSENT : bodyText,
    bodyExamples: chance(0.15)
      ? ABSENT
      : Array.from({ length: Math.max(0, count + pick([0, 0, 0, -1, 1])) }, () => val(() => good(VP, params))),
    footerText: opt(() => val(() => pick(["Powered by Eccos", " ok ", "", " ", "x".repeat(60), "x".repeat(61), "a {{1}}", "a\nb"]), 0.1), 0.5),
    buttons: arr(button, 4),
  };
}
function createInput(): unknown {
  if (chance(0.01)) return pick(junk);
  return rec({
    wabaId: "waba_1",
    name: opt(() => val(() => good(VN, names)), 0.03),
    language: opt(() => val(() => good(VL, langs)), 0.03),
    category: opt(() => pick(["MARKETING", "UTILITY", "MARKETING", "UTILITY", "AUTHENTICATION", "marketing", "", 1, null]), 0.03),
    ...content(),
  });
}
function editInput(): unknown {
  if (chance(0.01)) return pick(junk);
  return rec({
    wabaId: "waba_1",
    templateId: opt(() => val(() => good(VI, ids)), 0.03),
    name: opt(() => val(() => good(VN, names)), 0.03),
    language: opt(() => val(() => good(VL, langs)), 0.03),
    category: opt(() => pick(["MARKETING", "UTILITY", "AUTHENTICATION", "", 0, null, "utility"]), 0.4),
    ...content(),
  });
}

function setPath(obj: unknown, path: string, value: unknown): unknown {
  const out = structuredClone(obj) as Record<string, unknown>;
  const keys = path.split(".");
  let cursor = out;
  for (const k of keys.slice(0, -1)) cursor = cursor[k] as Record<string, unknown>;
  const last = keys[keys.length - 1] as string;
  if (value === ABSENT) delete cursor[last];
  else cursor[last] = value;
  return out;
}
/** The base request, every single-field variation, then every pair, so each rule's order is exercised. */
function* sweep(base: object, fields: Record<string, unknown[]>): Generator<unknown> {
  const keys = Object.keys(fields);
  yield base;
  for (const k of keys) for (const v of fields[k] ?? []) yield setPath(base, k, v);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i] as string;
      const b = keys[j] as string;
      if (b.startsWith(`${a}.`) || a.startsWith(`${b}.`)) continue;
      for (const x of fields[a] ?? []) for (const y of fields[b] ?? []) yield setPath(setPath(base, a, x), b, y);
    }
  }
}
function* random(gen: () => unknown, n: number): Generator<unknown> {
  for (let i = 0; i < n; i++) yield gen();
}
const J = [ABSENT, ...junk];
const sendBase = {
  wabaId: "waba_1",
  phoneNumberId: "123456",
  to: "34600111222",
  templateName: "order_update",
  languageCode: "en_US",
  bodyParams: ["Ada", "42"],
  buttonParams: [{ index: 1, text: "abc" }],
  headerMedia: { format: "image", link: "https://example.com/x.png" },
};
const sendFields: Record<string, unknown[]> = {
  templateName: [...J, ...names],
  languageCode: [...J, ...langs],
  bodyParams: [...J, Array.from({ length: 30 }, () => "v"), Array.from({ length: 31 }, () => "v")],
  "bodyParams.0": [...J, ...params],
  buttonParams: [...J, [0, 1, 2, 3].map((index) => ({ index, text: "t" }))],
  "buttonParams.0": [...J, "x"],
  "buttonParams.0.index": [...J, 0, 9, 10, -1, 1.5, "1", 2 ** 53],
  "buttonParams.0.text": [...J, ...params],
  headerMedia: [...J, "https://x.com"],
  "headerMedia.format": [...J, "image", "video", "document", "IMAGE", "audio", "sticker"],
  "headerMedia.link": [...J, ...urls],
};
const createBase = {
  wabaId: "waba_1",
  name: "order_update",
  language: "en_US",
  category: "UTILITY",
  bodyText: "Hi {{1}}, order {{2}}",
  bodyExamples: ["Ada", "42"],
  footerText: "Powered by Eccos",
  buttons: [
    { text: "Track", url: "https://ex.com/t?id={{1}}", exampleUrl: "https://ex.com/t?id=42" },
    { text: "Open", url: "https://example.com" },
  ],
};
const createFields: Record<string, unknown[]> = {
  name: [...J, ...names],
  language: [...J, ...langs],
  category: [...J, "MARKETING", "UTILITY", "AUTHENTICATION", "marketing"],
  bodyText: [...J, "", " ", "Hi {{1}}", "Hi {{1}} {{2}} {{3}}", "{{name}}", "{{0}} {{1}}", "{{1}} {{3}}", "x".repeat(1025), " Hi {{1}}, order {{2}} "],
  bodyExamples: [...J, ["a"], ["a", "b", "c"], Array.from({ length: 31 }, () => "v")],
  "bodyExamples.0": [...J, ...params],
  footerText: [...J, "", " ", "x".repeat(60), "x".repeat(61), "a {{1}}", "a\nb", "a\tb"],
  buttons: [...J, [], Array.from({ length: 4 }, () => ({ text: "a", url: "https://e.com" }))],
  "buttons.0": [...J, "x"],
  "buttons.0.text": [...J, "", " ", "x".repeat(25), "x".repeat(26), "a\nb"],
  "buttons.0.url": [...J, ...urls],
  "buttons.0.exampleUrl": [...J, ...urls],
  "buttons.1.url": [...J, ...urls],
  "buttons.1.exampleUrl": [...J, ...urls, ""],
};

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };
function outcome(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
function templatePart(value: unknown): unknown {
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !CONSOLE_FIELDS.includes(k)));
}

type Tally = { inputs: number; accepted: number; refused: number; gatewayOnly: number; disagreements: unknown[] };
function compare(
  consoleValidator: (input: unknown) => unknown,
  gatewayRule: (input: unknown) => unknown,
  inputs: Iterable<unknown>,
): Tally {
  const tally: Tally = { inputs: 0, accepted: 0, refused: 0, gatewayOnly: 0, disagreements: [] };
  const disagree = (input: unknown, atConsole: Outcome, atGateway: Outcome) => {
    if (tally.disagreements.length < 5) tally.disagreements.push({ input, atConsole, atGateway });
  };
  for (const input of inputs) {
    tally.inputs++;
    const atConsole = outcome(() => consoleValidator(structuredClone(input)));
    const atGateway = outcome(() => gatewayRule(structuredClone(input)));
    if (!atConsole.ok && CONSOLE_ONLY.has(atConsole.error)) continue;
    if (!atConsole.ok) {
      tally.refused++;
      if (!Bun.deepEquals(atGateway, atConsole, true)) disagree(input, atConsole, atGateway);
      continue;
    }
    tally.accepted++;
    // What the console forwards must fare at the gateway exactly as the raw input does.
    const forwarded = outcome(() => gatewayRule(structuredClone(atConsole.value)));
    if (!Bun.deepEquals(forwarded, atGateway, true)) disagree(atConsole.value, atGateway, forwarded);
    if (!atGateway.ok && GATEWAY_ONLY[atGateway.error]?.(atConsole.value as Record<string, unknown>)) {
      tally.gatewayOnly++;
      continue;
    }
    if (!Bun.deepEquals(atGateway, { ok: true, value: templatePart(atConsole.value) }, true)) {
      disagree(input, atConsole, atGateway);
    }
  }
  return tally;
}
function expectAgreement(tally: Tally) {
  expect(tally.disagreements).toEqual([]);
  expect(tally.accepted).toBeGreaterThan(1000);
  expect(tally.refused).toBeGreaterThan(1000);
  expect(tally.gatewayOnly).toBeGreaterThan(0);
}

const RANDOM_INPUTS = 4000;

describe("the console and the gateway agree on template requests", () => {
  test("test send", () => {
    expectAgreement(
      compare(consoleSide.validateSendTestInput, gatewaySide.templateSendRequest, [
        ...random(sendInput, RANDOM_INPUTS),
        ...sweep(sendBase, sendFields),
      ]),
    );
  });

  test("create", () => {
    expectAgreement(
      compare(consoleSide.validateCreateTemplateInput, gatewaySide.templateDraftRequest, [
        ...random(createInput, RANDOM_INPUTS),
        ...sweep(createBase, createFields),
      ]),
    );
  });

  test("edit", () => {
    expectAgreement(
      compare(consoleSide.validateEditTemplateInput, gatewaySide.templateEditRequest, [
        ...random(editInput, RANDOM_INPUTS),
        ...sweep({ ...createBase, templateId: "123" }, { ...createFields, templateId: [...J, ...ids] }),
      ]),
    );
  });
});
