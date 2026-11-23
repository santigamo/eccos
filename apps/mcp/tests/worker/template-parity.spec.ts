import type { Client } from "@modelcontextprotocol/client";
import type { AccountResources } from "@eccos/gateway-contract";
import { isBsuid } from "@eccos/core/bsuid";
import {
  TEMPLATE_ID_PATTERN,
  TEMPLATE_NAME_PATTERN,
  validateTemplateDraft,
  validateTemplateEdit,
  validateTemplateSend,
} from "@eccos/core/template-rules";
import consoleGateway from "../../../dashboard/src/server/gateway.ts?raw";
import { describe, expect, it, vi } from "vitest";
import { activeWaba, connect, gatewayStub, grantToken, makeActor, resetStubs } from "./helpers";

/**
 * The template tools refuse exactly what the console refuses, say what the console says, and send
 * the gateway exactly what the console would. Each case runs through the console's validators and
 * through the MCP tool, and any divergence fails:
 * - a: the console refuses and the tool accepts;
 * - b: the console accepts and the tool refuses;
 * - c: both refuse, and the tool's text does not carry the console's message;
 * - d: the tool refuses and still wrote to the gateway;
 * - e: both accept, and the gateway write differs from the console's.
 *
 * apps/dashboard/src/server/gateway.ts imports cloudflare:workers, @tanstack/react-start and the
 * auth stack, so it is not importable here. The template rules come from @eccos/core directly; the
 * three console-only helpers below are copied verbatim from apps/dashboard/src/server/gateway.ts
 * (validateRecipient, idempotencyKey, and validateDeleteTemplateInput without its wabaId line), and
 * the last test fails if the console's copies change.
 */
const RECIPIENT_PATTERN = /^[0-9]{5,15}$/;
function validateRecipient(value: unknown): string {
  if (typeof value !== "string") throw new Error("recipient is required");
  if (isBsuid(value.trim())) return value.trim();
  const to = value.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!RECIPIENT_PATTERN.test(to)) {
    throw new Error("recipient must be 5 to 15 digits in international format, or a BSUID");
  }
  return to;
}
function idempotencyKey(value: unknown): { idempotencyKey?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid idempotency key");
  return { idempotencyKey: value };
}
function consoleDelete(record: Record<string, unknown>) {
  if (typeof record.name !== "string" || !TEMPLATE_NAME_PATTERN.test(record.name.trim())) {
    throw new Error("invalid template name");
  }
  if (typeof record.templateId !== "string" || !TEMPLATE_ID_PATTERN.test(record.templateId.trim())) {
    throw new Error("invalid template id");
  }
  return { name: record.name.trim(), templateId: record.templateId.trim() };
}
function consoleSend(record: Record<string, unknown>) {
  // validateSendTestInput minus wabaId/phoneNumberId (required in the console, optional in MCP).
  const to = validateRecipient(record.to);
  return { to, ...validateTemplateSend(record), ...idempotencyKey(record.idempotencyKey) };
}

type Tool = "template_create" | "template_edit" | "template_delete" | "template_send_test";
interface Case { tool: Tool; label: string; args: Record<string, unknown> }
const WRITE: Record<Tool, string> = {
  template_create: "createTemplate",
  template_edit: "editTemplate",
  template_delete: "deleteTemplate",
  template_send_test: "sendTemplateTest",
};

const pad = (s: string) => `  ${s}  `;
const x = (n: number, c = "x") => c.repeat(n);
const body = (n: number) => `Text ${Array.from({ length: n }, (_, i) => `{{${i + 1}} } w`).join(" ").replaceAll("} }", "}}")} end`;
const ex = (n: number) => Array.from({ length: n }, (_, i) => `v${i + 1}`);
const DYN = { text: "Track", url: "https://shop.example/t/{{1}}", exampleUrl: "https://shop.example/t/A-1" };
const STATIC = { text: "Shop", url: "https://shop.example" };

const CONTENT = {
  bodyText: "Hi {{1}}, order {{2}} is ready for pickup.",
  bodyExamples: ["Ana", "A-1042"],
  footerText: "Reply STOP to unsubscribe",
  buttons: [DYN],
};
const contentMutations: [string, Record<string, unknown>][] = [
  ["baseline", {}],
  ["no footer no buttons", { footerText: undefined, buttons: undefined }],
  ["body empty", { bodyText: "", bodyExamples: [] }],
  ["body spaces", { bodyText: "   ", bodyExamples: [] }],
  ["body padded kept", { bodyText: "  Hi {{1}}  ", bodyExamples: ["a"] }],
  ["body 1024", { bodyText: x(1024), bodyExamples: [] }],
  ["body 1025", { bodyText: x(1025), bodyExamples: [] }],
  ["body 1023+2 spaces", { bodyText: `${x(1023)}  `, bodyExamples: [] }],
  ["body named", { bodyText: "Hi {{name}}", bodyExamples: ["a"] }],
  ["body gapped", { bodyText: "Hi {{1}} and {{3}}", bodyExamples: ["a", "b"] }],
  ["body {{0}}", { bodyText: "Hi {{0}}", bodyExamples: [] }],
  ["body spaced placeholder", { bodyText: "Hi {{ 1 }} there", bodyExamples: ["a"] }],
  ["body 30 params", { bodyText: body(30), bodyExamples: ex(30) }],
  ["body 31 params", { bodyText: body(31), bodyExamples: ex(31) }],
  ["body 31 params 30 examples", { bodyText: body(31), bodyExamples: ex(30) }],
  ["body newline tab", { bodyText: "Hi\n{{1}}\tthere", bodyExamples: ["a"] }],
  ["body unicode", { bodyText: "Hola {{1}} 🎉 ñandú", bodyExamples: ["Ñ"] }],
  ["examples missing", { bodyExamples: undefined }],
  ["examples short", { bodyExamples: ["Ana"] }],
  ["examples extra", { bodyExamples: ["Ana", "A", "B"] }],
  ["examples padded", { bodyExamples: [" Ana ", "\tA-1\t"] }],
  ["example blank", { bodyExamples: ["Ana", "   "] }],
  ["example empty", { bodyExamples: ["Ana", ""] }],
  ["example 1024", { bodyExamples: ["Ana", x(1024)] }],
  ["example 1025", { bodyExamples: ["Ana", x(1025)] }],
  ["example 1024 padded", { bodyExamples: ["Ana", pad(x(1024))] }],
  ["example newline", { bodyExamples: ["Ana", "a\nb"] }],
  ["example tab", { bodyExamples: ["Ana", "a\tb"] }],
  ["example unicode", { bodyExamples: ["Ána 🎉", "日本"] }],
  ["examples 31 for 2", { bodyExamples: ex(31) }],
  ["footer padded", { footerText: pad("Reply STOP") }],
  ["footer 60", { footerText: x(60) }],
  ["footer 61", { footerText: x(61) }],
  ["footer 60 padded", { footerText: pad(x(60)) }],
  ["footer 58 padded", { footerText: ` ${x(58)}  ` }],
  ["footer 59 + trailing tab", { footerText: `${x(59)}\t` }],
  ["footer inner newline", { footerText: "a\nb" }],
  ["footer inner tab", { footerText: "a\tb" }],
  ["footer placeholder", { footerText: "Order {{1}}" }],
  ["footer empty", { footerText: "" }],
  ["footer spaces", { footerText: "   " }],
  ["footer unicode", { footerText: "Responde BAJA 🙏" }],
  ["button text padded", { buttons: [{ ...DYN, text: " Track " }] }],
  ["button text 25", { buttons: [{ ...DYN, text: x(25) }] }],
  ["button text 26", { buttons: [{ ...DYN, text: x(26) }] }],
  ["button text 25 padded", { buttons: [{ ...DYN, text: pad(x(25)) }] }],
  ["button text 24 + 2 spaces", { buttons: [{ ...DYN, text: `${x(24)}  ` }] }],
  ["button text empty", { buttons: [{ ...DYN, text: "" }] }],
  ["button text spaces", { buttons: [{ ...DYN, text: "   " }] }],
  ["button text tab", { buttons: [{ ...DYN, text: "a\tb" }] }],
  ["button text newline", { buttons: [{ ...DYN, text: "a\nb" }] }],
  ["button url padded", { buttons: [{ ...DYN, url: pad(DYN.url) }] }],
  ["button url http", { buttons: [{ ...STATIC, url: "http://shop.example" }] }],
  ["button url ftp", { buttons: [{ ...STATIC, url: "ftp://shop.example" }] }],
  ["button url empty", { buttons: [{ ...STATIC, url: "" }] }],
  ["button url newline", { buttons: [{ ...STATIC, url: "https://shop.example/a\nb" }] }],
  ["button url uppercase scheme", { buttons: [{ ...STATIC, url: "HTTPS://shop.example" }] }],
  ["button static", { buttons: [STATIC] }],
  ["button static exampleUrl empty", { buttons: [{ ...STATIC, exampleUrl: "" }] }],
  ["button static exampleUrl spaces", { buttons: [{ ...STATIC, exampleUrl: "  " }] }],
  ["button static exampleUrl set", { buttons: [{ ...STATIC, exampleUrl: "https://shop.example/x" }] }],
  ["button dynamic no example", { buttons: [{ text: "Track", url: DYN.url }] }],
  ["button dynamic example spaces", { buttons: [{ ...DYN, exampleUrl: "  " }] }],
  ["button dynamic example padded", { buttons: [{ ...DYN, exampleUrl: pad(DYN.exampleUrl) }] }],
  ["button dynamic example http", { buttons: [{ ...DYN, exampleUrl: "http://shop.example/t/A" }] }],
  ["button dynamic example ftp", { buttons: [{ ...DYN, exampleUrl: "ftp://shop.example/t/A" }] }],
  ["buttons 3", { buttons: [DYN, STATIC, STATIC] }],
  ["buttons 4", { buttons: [DYN, STATIC, STATIC, STATIC] }],
  ["buttons empty array", { buttons: [] }],
];

const CREATE = { name: "order_ready", language: "en_US", category: "UTILITY", ...CONTENT };
const EDIT = { templateId: "900100", name: "order_update", language: "en_US", ...CONTENT };
const nameMutations: [string, unknown][] = [
  ["lead space", " order_ready"], ["trail space", "order_ready "], ["tab", "\torder_ready\n"], ["upper", "Order_Ready"],
  ["dash", "order-ready"], ["empty", ""], ["512", x(512, "a")], ["513", x(513, "a")], ["512 padded", pad(x(512, "a"))],
  ["accent", "órder"], ["inner newline", "order\nready"],
];
const langMutations: [string, unknown][] = [
  ["lead space", " en_US"], ["trail space", "en_US "], ["lower region", "en_us"], ["upper", "EN"], ["es", "es"],
  ["pt_BR", "pt_BR"], ["empty", ""], ["eng", "eng"], ["one letter", "e"], ["en_USA", "en_USA"], ["newline", "en_US\n"],
];
const idMutations: [string, unknown][] = [
  ["lead space", " 900100"], ["trail space", "900100 "], ["letters", "abc"], ["empty", ""], ["32", x(32, "1")],
  ["33", x(33, "1")], ["32 padded", pad(x(32, "1"))], ["neg", "-1"],
];

function cases(): Case[] {
  const out: Case[] = [];
  const del = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  for (const [label, change] of contentMutations) {
    out.push({ tool: "template_create", label: `content ${label}`, args: del({ ...CREATE, ...change }) });
    out.push({ tool: "template_edit", label: `content ${label}`, args: del({ ...EDIT, ...change }) });
  }
  for (const [label, name] of nameMutations) {
    out.push({ tool: "template_create", label: `name ${label}`, args: { ...CREATE, name } });
    out.push({ tool: "template_edit", label: `name ${label}`, args: { ...EDIT, name } });
    out.push({ tool: "template_delete", label: `name ${label}`, args: { templateId: "900100", name } });
    out.push({ tool: "template_send_test", label: `templateName ${label}`, args: { to: "34600000011", templateName: name, languageCode: "en_US", bodyParams: ["a", "b"] } });
  }
  for (const [label, language] of langMutations) {
    out.push({ tool: "template_create", label: `language ${label}`, args: { ...CREATE, language } });
    out.push({ tool: "template_edit", label: `language ${label}`, args: { ...EDIT, language } });
    out.push({ tool: "template_send_test", label: `languageCode ${label}`, args: { to: "34600000011", templateName: "order_update", languageCode: language, bodyParams: ["a", "b"] } });
  }
  for (const [label, templateId] of idMutations) {
    out.push({ tool: "template_edit", label: `templateId ${label}`, args: { ...EDIT, templateId } });
    out.push({ tool: "template_delete", label: `templateId ${label}`, args: { templateId, name: "spring_promo" } });
  }
  for (const category of ["AUTHENTICATION", "utility", "MARKETING", undefined]) {
    out.push({ tool: "template_create", label: `category ${String(category)}`, args: del({ ...CREATE, category }) });
    out.push({ tool: "template_edit", label: `category ${String(category)}`, args: del({ ...EDIT, category }) });
  }
  out.push({ tool: "template_delete", label: "baseline", args: { templateId: "900300", name: "spring_promo" } });

  const SEND = { to: "+34 600-000 011", templateName: "order_update", languageCode: "en_US", bodyParams: [" Ana ", "A-1"] };
  const send = (label: string, change: Record<string, unknown>) =>
    out.push({ tool: "template_send_test", label, args: del({ ...SEND, ...change }) });
  send("baseline", {});
  const recipients: [string, string][] = [
    ["plus spaces", "+34 600 000 011"], ["digits", "34600000011"], ["parens dots", "(34) 600.000.011"], ["dashes", "+34-600-000-011"],
    ["4 digits", "1234"], ["5 digits", "12345"], ["15 digits", x(15, "1")], ["16 digits", x(16, "1")], ["plus 15", `+${x(15, "1")}`],
    ["plus 16", `+${x(16, "1")}`], ["double plus", "++34600000011"], ["inner plus", "34+600000011"], ["trailing letter", "34600000011x"],
    ["slash", "34/600000011"], ["tab newline", "\t34600000011\n"], ["fullwidth digits", "３４６００００００１１"], ["empty", ""],
    ["bsuid", "US.13491208655302741918"], ["bsuid padded", "  US.13491208655302741918  "], ["bsuid ent", "US.ENT.abc123"],
    ["bsuid lower", "us.123"], ["bsuid empty", "US."], ["bsuid inner space", "US. 123"],
    ["padded 151", `${x(140, " ")}34600000011`], ["padded 160", `${x(149, " ")}34600000011`], ["padded 161", `${x(150, " ")}34600000011`],
    ["padded 300", `${x(289, " ")}34600000011`], ["dashes 170", `34600000011${x(159, "-")}`], ["bsuid padded 170", `${x(80, " ")}US.123${x(84, " ")}`],
    ["nbsp", "34\u00a0600000011"],
  ];
  for (const [label, to] of recipients) send(`to ${label}`, { to });
  const params: [string, unknown][] = [
    ["blank", [" Ana ", " "]], ["empty", ["Ana", ""]], ["1024", ["Ana", x(1024)]], ["1025", ["Ana", x(1025)]],
    ["1024 padded", ["Ana", pad(x(1024))]], ["newline", ["Ana", "a\nb"]], ["tab", ["Ana", "a\tb"]], ["trailing newline", ["Ana", "ab\n"]],
    ["unicode", ["Ána 🎉", "日本"]], ["30", ex(30)], ["31", ex(31)], ["none", undefined], ["empty array", []],
  ];
  for (const [label, bodyParams] of params) send(`bodyParams ${label}`, { bodyParams });
  const TRACK = { templateName: "track_link", bodyParams: undefined };
  const buttonParams: [string, unknown][] = [
    ["index 0", [{ index: 0, text: "A-1" }]], ["index 9", [{ index: 9, text: "A-1" }]], ["index -1", [{ index: -1, text: "A-1" }]],
    ["index 10", [{ index: 10, text: "A-1" }]], ["index 1.5", [{ index: 1.5, text: "A-1" }]], ["text padded", [{ index: 0, text: " A-1 " }]],
    ["text empty", [{ index: 0, text: "" }]], ["text spaces", [{ index: 0, text: "  " }]], ["text newline", [{ index: 0, text: "a\nb" }]],
    ["text 1025", [{ index: 0, text: x(1025) }]], ["text 1024 padded", [{ index: 0, text: pad(x(1024)) }]],
    ["3 entries", [0, 1, 2].map((index) => ({ index, text: "a" }))], ["4 entries", [0, 1, 2, 3].map((index) => ({ index, text: "a" }))],
    ["duplicate index", [{ index: 0, text: "a" }, { index: 0, text: "b" }]],
  ];
  for (const [label, value] of buttonParams) send(`buttonParams ${label}`, { ...TRACK, buttonParams: value });
  const media: [string, unknown][] = [
    ["https", { format: "image", link: "https://cdn.example/p.jpg" }], ["http", { format: "image", link: "http://cdn.example/p.jpg" }],
    ["credentials", { format: "image", link: "https://user:pw@cdn.example/p.jpg" }], ["user only", { format: "image", link: "https://user@cdn.example/p.jpg" }],
    ["padded", { format: "image", link: pad("https://cdn.example/p.jpg") }], ["not a url", { format: "image", link: "cdn.example/p.jpg" }],
    ["empty", { format: "image", link: "" }], ["audio", { format: "audio", link: "https://cdn.example/p.mp3" }],
    ["2048", { format: "image", link: `https://cdn.example/${x(2028, "a")}` }], ["2049", { format: "image", link: `https://cdn.example/${x(2029, "a")}` }],
    ["data uri", { format: "image", link: "data:image/png;base64,AAAA" }], ["video", { format: "video", link: "https://cdn.example/v.mp4" }],
  ];
  for (const [label, headerMedia] of media) send(`headerMedia ${label}`, { ...TRACK, buttonParams: [{ index: 0, text: "A-1" }], headerMedia });
  const keys: [string, string][] = [
    ["v4 lower", "8a7c1f0e-3b2d-4c5e-9f6a-1b2c3d4e5f60"], ["v4 upper", "8A7C1F0E-3B2D-4C5E-9F6A-1B2C3D4E5F60"],
    ["nil", "00000000-0000-0000-0000-000000000000"], ["max", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["version 0", "8a7c1f0e-3b2d-0c5e-9f6a-1b2c3d4e5f60"], ["variant c", "8a7c1f0e-3b2d-4c5e-cf6a-1b2c3d4e5f60"],
    ["36 dashes", x(36, "-")], ["36 hex no dashes", x(36, "a")], ["dashes misplaced", "8a7c1f0e3b2d-4c5e-9f6a-1b2c3d4e5f60-"],
    ["padded", " 8a7c1f0e-3b2d-4c5e-9f6a-1b2c3d4e5f60"], ["empty", ""], ["v7", "019a2b3c-4d5e-7f60-8a7c-1f0e3b2d4c5e"],
  ];
  for (const [label, key] of keys) send(`idempotencyKey ${label}`, { idempotencyKey: key });
  return out;
}

function consoleVerdict(c: Case): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const value =
      c.tool === "template_create" ? validateTemplateDraft(c.args)
      : c.tool === "template_edit" ? validateTemplateEdit(c.args)
      : c.tool === "template_delete" ? consoleDelete(c.args)
      : consoleSend(c.args);
    return { ok: true, value: value as unknown as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** The approved row a send would need, built from the raw arguments, so the MCP row check never masks a validation verdict. */
function rowFor(args: Record<string, unknown>) {
  const n = Array.isArray(args.bodyParams) ? args.bodyParams.length : 0;
  const indices = (Array.isArray(args.buttonParams) ? args.buttonParams : [])
    .map((b) => (b as { index?: unknown }).index)
    .filter((i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0 && i <= 9);
  const components: Record<string, unknown>[] = [];
  const format = (args.headerMedia as { format?: unknown } | undefined)?.format;
  if (typeof format === "string" && ["image", "video", "document"].includes(format)) components.push({ type: "HEADER", format: format.toUpperCase() });
  components.push({ type: "BODY", text: n === 0 ? "Plain body." : body(n) });
  if (indices.length > 0) {
    const max = Math.max(...indices);
    components.push({
      type: "BUTTONS",
      buttons: Array.from({ length: max + 1 }, (_, i) => ({ type: "URL", text: `b${i}`, url: indices.includes(i) ? "https://s.example/{{1}}" : "https://s.example" })),
    });
  }
  // Meta stores a template's name and language trimmed, as the console and the tool send them.
  const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : value);
  return { id: "900999", name: trimmed(args.templateName), language: trimmed(args.languageCode), status: "APPROVED", category: "UTILITY", components };
}

const resources = (): AccountResources => ({
  account: { accountId: "acct-a", name: "acct-a", createdAt: 1, connectPolicy: "open" },
  keys: [],
  wabas: [activeWaba("waba-a", "acct-a", ["111"])],
  phones: [],
});

async function mcpVerdict(client: Client, c: Case) {
  try {
    const result = await client.callTool({ name: c.tool, arguments: c.args });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    return result.isError ? { ok: false as const, message: text } : { ok: true as const, message: text };
  } catch (error) {
    return { ok: false as const, message: `THROWN ${(error as Error).message}` };
  }
}

const strip = (m: string) => m.replace(/\.$/, "");

describe("template tools against the console's validators", () => {
  it("diverge on no input", { timeout: 600_000 }, async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await resetStubs();
    const all = cases();
    const divergent: Record<string, unknown>[] = [];
    for (const c of all) {
      await gatewayStub.seed("acct-a", {
        resources: resources(),
        templates: { "waba-a": { ok: true, data: { data: [rowFor(c.args)] } } },
      });
      const before = (await gatewayStub.calls()).length;
      const consoleSays = consoleVerdict(c);
      // A fresh actor per case: the MCP rate limiter allows 30 requests a minute per user and client.
      const client = await connect(await grantToken(makeActor()));
      const mcp = await mcpVerdict(client, c);
      await client.close();
      const writes = (await gatewayStub.calls()).slice(before).filter((call) => call.method === WRITE[c.tool]);
      const classes: string[] = [];
      if (!consoleSays.ok && mcp.ok) classes.push("a");
      if (consoleSays.ok && !mcp.ok) classes.push("b");
      if (!consoleSays.ok && !mcp.ok && !mcp.message.includes(strip(consoleSays.message))) classes.push("c");
      if (!mcp.ok && writes.length > 0) classes.push("d");
      let mismatch: Record<string, unknown> = {};
      if (consoleSays.ok && mcp.ok) {
        const expected = { wabaId: "waba-a", ...(c.tool === "template_send_test" ? { phoneNumberId: "111" } : {}), ...consoleSays.value };
        const got = writes[0]?.input;
        if (writes.length !== 1 || JSON.stringify(sortKeys(got)) !== JSON.stringify(sortKeys(expected))) {
          classes.push("e");
          mismatch = { got: clip(got), expected: clip(expected) };
        }
      }
      if (classes.length > 0) {
        divergent.push({
          tool: c.tool,
          label: c.label,
          classes,
          console: consoleSays.ok ? "accept" : `refuse: ${consoleSays.message}`,
          mcp: mcp.ok ? "accept" : `refuse: ${mcp.message.slice(0, 400)}`,
          ...mismatch,
        });
      }
    }

    expect(all.length).toBeGreaterThan(300);
    expect(divergent).toEqual([]);
  });

  it("uses the console's own recipient, idempotency key and delete rules", () => {
    const flat = (source: string) => source.replace(/\s+/g, " ");
    for (const snippet of [
      'const to = value.replace(/[\\s\\-().]/g, "").replace(/^\\+/, "");',
      'throw new Error("recipient must be 5 to 15 digits in international format, or a BSUID");',
      'if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid idempotency key");',
      'if (typeof record.name !== "string" || !TEMPLATE_NAME_PATTERN.test(record.name.trim())) { throw new Error("invalid template name"); }',
      'if (typeof record.templateId !== "string" || !TEMPLATE_ID_PATTERN.test(record.templateId.trim())) { throw new Error("invalid template id"); }',
    ]) {
      expect(flat(consoleGateway)).toContain(flat(snippet));
    }
  });
});

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

const clip = (v: unknown) => {
  const s = JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}…(${s.length})` : s;
};

