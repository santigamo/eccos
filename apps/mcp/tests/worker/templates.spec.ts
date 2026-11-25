import type { Client } from "@modelcontextprotocol/client";
import type { AgentAction } from "@eccos/console-contract";
import type { AccountResources, AccountWabaResource } from "@eccos/gateway-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountFixture } from "../stubs/gateway";
import { activeWaba, connect, gatewayStub, grantToken, makeActor, postMcp, resetStubs, toolsCall } from "./helpers";

const ORDER_UPDATE = {
  id: "900100",
  name: "order_update",
  language: "en_US",
  status: "APPROVED",
  category: "UTILITY",
  components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is on its way.", example: { body_text: [["Ana", "A-1"]] } }],
};
const TRACK_LINK = {
  id: "900200",
  name: "track_link",
  language: "en_US",
  status: "APPROVED",
  category: "UTILITY",
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Your parcel is ready." },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://shop.example/t/{{1}}" }] },
  ],
};
const PROMO = {
  id: "900300",
  name: "spring_promo",
  language: "es",
  status: "REJECTED",
  category: "MARKETING",
  rejected_reason: "PROMOTIONAL",
  quality_score: { score: "UNKNOWN" },
  components: [{ type: "BODY", text: "Rebajas" }],
};
const LOGIN_CODE = { id: "900400", name: "login_code", language: "en_US", status: "APPROVED", category: "AUTHENTICATION", components: [] };

const account = (accountId: string, wabas: AccountWabaResource[]): AccountResources => ({
  account: { accountId, name: accountId, createdAt: 1, billingStatus: "open", canAddNumber: true },
  keys: [],
  wabas,
  phones: [],
});

const templatesOf = (...rows: unknown[]) => ({ ok: true as const, data: { data: rows } });

async function seedA(fixture: Partial<AccountFixture> = {}) {
  await gatewayStub.seed("acct-a", {
    resources: account("acct-a", [activeWaba("waba-a", "acct-a", ["111"])]),
    templates: { "waba-a": templatesOf(ORDER_UPDATE, TRACK_LINK, PROMO, LOGIN_CODE) },
    ...fixture,
  });
}

async function seedB() {
  await gatewayStub.seed("acct-b", {
    resources: account("acct-b", [activeWaba("waba-b", "acct-b", ["222"])]),
    templates: { "waba-b": templatesOf({ ...ORDER_UPDATE, id: "800100", name: "b_private" }) },
  });
}

let lines: unknown[][] = [];

beforeEach(async () => {
  await resetStubs();
  lines = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const auditLines = () =>
  lines.map(([first]) => JSON.parse(String(first)) as Record<string, unknown>).filter((line) => line.area === "audit");

/** Call a tool; the text block is always the structured content or the whole error message. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  if (!result.isError) expect(JSON.parse(text)).toEqual(result.structuredContent);
  return { ...result, text };
}

async function as(actions: AgentAction[] = ["view", "operate", "send", "configure", "administer"], scope?: string[]) {
  return connect(await grantToken(makeActor({ actions }), scope));
}

const writes = async (method: string) => (await gatewayStub.calls()).filter((entry) => entry.method === method);

const CREATE = {
  name: "order_ready",
  language: "en_US",
  category: "UTILITY",
  bodyText: "Hi {{1}}, order {{2}} is ready for pickup.",
  bodyExamples: [" Ana ", "A-1042"],
  footerText: " Reply STOP to unsubscribe ",
  buttons: [{ text: "Track", url: "https://shop.example/t/{{1}}", exampleUrl: "https://shop.example/t/A-1042" }],
};

describe("templates_list", () => {
  it("lists templates with what a test send of each needs", async () => {
    await seedA();
    const client = await as(["view"], ["eccos:view"]);
    const result = await call(client, "templates_list");
    await client.close();

    expect(result.isError).toBeFalsy();
    const { wabaId, templates, truncated } = result.structuredContent as { wabaId: string; templates: Record<string, unknown>[]; truncated: boolean };
    expect({ wabaId, truncated }).toEqual({ wabaId: "waba-a", truncated: false });
    expect(templates.map(({ name, testSend }) => ({ name, testSend }))).toEqual([
      { name: "order_update", testSend: { ready: true, bodyParamCount: 2, buttonParams: [], headerMedia: null } },
      { name: "track_link", testSend: { ready: true, bodyParamCount: 0, buttonParams: [{ index: 0, urlPrefix: "https://shop.example/t/" }], headerMedia: "image" } },
      { name: "spring_promo", testSend: { ready: false, reason: "Its status is REJECTED; only an APPROVED template can be sent." } },
      { name: "login_code", testSend: { ready: false, reason: expect.stringContaining("Authentication templates") } },
    ]);
    expect(templates[2]).toMatchObject({ id: "900300", language: "es", category: "MARKETING", rejectedReason: "PROMOTIONAL", quality: "UNKNOWN" });
    expect(templates[0]).toMatchObject({ rejectedReason: null, quality: null, components: ORDER_UPDATE.components });
  });

  it("filters by status and by name", async () => {
    await seedA();
    const client = await as(["view"]);
    const approved = await call(client, "templates_list", { status: "APPROVED", name: "ORDER" });
    await client.close();

    expect((approved.structuredContent as { templates: { name: string }[] }).templates.map((row) => row.name)).toEqual(["order_update"]);
  });

  it("says what to do when Meta refuses the read", async () => {
    await seedA({ templates: { "waba-a": { ok: false, error: { error: { message: "Error validating access token", code: 190 } } } } });
    const client = await as(["view"]);
    const result = await call(client, "templates_list");
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'Meta did not return the templates of WABA "waba-a". Meta said: "Error validating access token" Try again in a minute. If Meta says the access token is invalid or expired, call numbers_list to check the number\'s token.',
    );
  });

  it("needs a wabaId when the workspace has several, and refuses one it does not have", async () => {
    await gatewayStub.seed("acct-a", {
      resources: account("acct-a", [activeWaba("waba-a2", "acct-a", ["112"]), activeWaba("waba-a", "acct-a", ["111"])]),
      templates: { "waba-a2": templatesOf(PROMO) },
    });
    const client = await as(["view"]);
    const ambiguous = await call(client, "templates_list");
    const unknown = await call(client, "templates_list", { wabaId: "waba-zz" });
    const chosen = await call(client, "templates_list", { wabaId: "waba-a2" });
    await client.close();

    expect(ambiguous.text).toBe(
      "This workspace has 2 WhatsApp Business accounts: waba-a, waba-a2. Call again with wabaId set to one of them. Call numbers_list to see the numbers on each.",
    );
    expect(unknown.text).toBe("WABA waba-zz is not connected to this workspace. Its WABAs are: waba-a, waba-a2. Call numbers_list to see them.");
    expect(chosen.structuredContent).toMatchObject({ wabaId: "waba-a2", templates: [{ name: "spring_promo" }] });
  });

  it("points at connect_link_create when no number is connected, only for a connection that may call it", async () => {
    await gatewayStub.seed("acct-a", { resources: account("acct-a", []) });
    const admin = await as(["view", "administer"]);
    const owner = await call(admin, "templates_list");
    await admin.close();
    const viewer = await as(["view"]);
    const refused = await call(viewer, "templates_list");
    await viewer.close();

    expect(owner.isError).toBe(true);
    expect(owner.text).toContain("Call connect_link_create");
    expect(refused.text).toBe(
      "No WhatsApp Business account is connected to this workspace yet. This connection was not granted the eccos:administer scope that administer needs. Ask the person to connect the agent again and grant it.",
    );
  });

  it("works on a WABA still waiting for its number, as the console does", async () => {
    const pending = { ...activeWaba("waba-a", "acct-a", []), status: "pending" as const };
    await seedA({ resources: account("acct-a", [pending]) });
    const client = await as(["view"]);
    const result = await call(client, "templates_list");
    await client.close();

    expect(result.isError).toBeFalsy();
  });
});

describe("template_create", () => {
  it("submits the template with the console's normalization and says what comes next", async () => {
    await seedA({ results: { createTemplate: { ok: true, id: "990001", status: "PENDING", category: "MARKETING" } } });
    const client = await as();
    const result = await call(client, "template_create", CREATE);
    await client.close();

    expect(result.structuredContent).toEqual({
      wabaId: "waba-a",
      templateId: "990001",
      name: "order_ready",
      language: "en_US",
      status: "PENDING",
      category: "MARKETING",
      categoryChanged: true,
      next: 'Meta is reviewing it. Call templates_list with name "order_ready" until its status is APPROVED. Then call template_send_test.',
    });
    expect((await writes("createTemplate")).map((entry) => entry.input)).toEqual([
      {
        wabaId: "waba-a",
        name: "order_ready",
        language: "en_US",
        category: "UTILITY",
        bodyText: "Hi {{1}}, order {{2}} is ready for pickup.",
        bodyExamples: ["Ana", "A-1042"],
        footerText: "Reply STOP to unsubscribe",
        buttons: [{ text: "Track", url: "https://shop.example/t/{{1}}", exampleUrl: "https://shop.example/t/A-1042" }],
      },
    ]);
    expect(auditLines()).toEqual([
      expect.objectContaining({
        action: "template_create",
        resource: { wabaId: null, template: "order_ready", language: "en_US", category: "UTILITY" },
        outcome: "success",
        detail: null,
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("pickup");
  });

  it("does not point a connection that cannot send at template_send_test", async () => {
    await seedA();
    const client = await as(["view", "configure"]);
    const result = await call(client, "template_create", CREATE);
    await client.close();

    expect(result.structuredContent).toMatchObject({
      next: 'Meta is reviewing it. Call templates_list with name "order_ready" until its status is APPROVED.',
    });
  });

  it.each([
    [{ bodyText: "Hi {{name}}", bodyExamples: ["Ana"] }, "Refused before reaching Meta: Named parameters cannot be created here — use {{1}}, {{2}}… instead. Fix it and call template_create again."],
    [{ bodyText: "Hi {{1}} and {{3}}", bodyExamples: ["a", "b"] }, "Refused before reaching Meta: Variables must run {{1}} to {{3}} with no gaps — {{2}} is missing. Fix it and call template_create again."],
    [{ bodyExamples: ["Ana"] }, "Refused before reaching Meta: this body needs exactly 2 example value(s). Fix it and call template_create again."],
    [{ bodyExamples: ["Ana", "two\nlines"] }, "Refused before reaching Meta: example values cannot contain line breaks. Fix it and call template_create again."],
    [{ footerText: "Order {{1}}" }, "Refused before reaching Meta: footer text cannot contain placeholders. Fix it and call template_create again."],
    [{ footerText: "  " }, "Refused before reaching Meta: footer text cannot be empty. Fix it and call template_create again."],
    [{ buttons: [{ text: "Shop", url: "https://shop.example", exampleUrl: "https://shop.example/x" }] }, "Refused before reaching Meta: a static URL button carries no example. Fix it and call template_create again."],
    [{ buttons: [{ text: "Track", url: "https://shop.example/t/{{1}}" }] }, "Refused before reaching Meta: a dynamic URL button needs an example url. Fix it and call template_create again."],
    [{ buttons: [{ text: "Shop", url: "ftp://shop.example" }] }, "Refused before reaching Meta: button url must be https. Fix it and call template_create again."],
  ])("refuses what the console refuses, before reaching Meta: %j", async (change, message) => {
    await seedA();
    const client = await as();
    const result = await call(client, "template_create", { ...CREATE, ...change });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.text).toBe(message);
    expect(await writes("createTemplate")).toEqual([]);
  });

  it("refuses a malformed name or an authentication category in the schema", async () => {
    await seedA();
    const client = await as();
    const badName = await call(client, "template_create", { ...CREATE, name: "Order Ready" });
    const auth = await call(client, "template_create", { ...CREATE, category: "AUTHENTICATION" });
    await client.close();

    expect(badName.isError).toBe(true);
    expect(badName.text).toContain("name");
    expect(auth.isError).toBe(true);
    expect(await writes("createTemplate")).toEqual([]);
  });

  it.each([
    [
      { ok: false, code: "name_taken", detail: "dup" },
      'A template named "order_ready" already exists in en_US on WABA "waba-a", or was deleted less than 30 days ago (Meta locks the name). Pick another name. To change the existing one, call templates_list with name "order_ready" and use template_edit.',
    ],
    [{ ok: false, code: "invalid", detail: "Param text has too many variables" }, 'Meta refused the template\'s content. Meta said: "Param text has too many variables" Fix it and call template_create again.'],
    [
      { ok: false, code: "rate_limited", detail: null },
      "Meta is rate-limiting template changes for this WhatsApp Business account. Wait a few minutes before calling template_create again; do not retry in a loop.",
    ],
    [{ ok: false, code: "graph", detail: null }, "Meta refused the template. Tell the person if it is not something you can fix."],
  ] as const)("turns the gateway's %j into an actionable error", async (refusal, message) => {
    await seedA({ results: { createTemplate: refusal } });
    const client = await as();
    const result = await call(client, "template_create", CREATE);
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.text).toBe(message);
    expect(auditLines()).toEqual([expect.objectContaining({ action: "template_create", outcome: "failed", detail: refusal.code })]);
  });
});

describe("template_edit", () => {
  const EDIT = { templateId: "900100", name: "order_update", language: "en_US", bodyText: "Hi {{1}}, order {{2}} shipped.", bodyExamples: ["Ana", "A-1"] };

  it("replaces one translation's content", async () => {
    await seedA();
    const client = await as();
    const result = await call(client, "template_edit", EDIT);
    await client.close();

    expect(result.structuredContent).toEqual({
      wabaId: "waba-a",
      templateId: "900100",
      name: "order_update",
      language: "en_US",
      next: 'Meta reviews the new content. Call templates_list with name "order_update" until its status is APPROVED.',
    });
    expect((await writes("editTemplate")).map((entry) => entry.input)).toEqual([{ wabaId: "waba-a", ...EDIT }]);
    expect(auditLines()).toEqual([
      expect.objectContaining({ action: "template_edit", resource: { wabaId: null, template: "order_update", language: "en_US", templateId: "900100" } }),
    ]);
  });

  it("runs the same content rules as create", async () => {
    await seedA();
    const client = await as();
    const result = await call(client, "template_edit", { ...EDIT, bodyExamples: [] });
    await client.close();

    expect(result.text).toBe("Refused before reaching Meta: this body needs exactly 2 example value(s). Fix it and call template_edit again.");
    expect(await writes("editTemplate")).toEqual([]);
  });

  it.each([
    [{ ok: false, code: "not_found", detail: null }, 'WABA "waba-a" has no template with id "900100" named "order_update" in en_US. Call templates_list and pass the id, name and language of one row.'],
    [{ ok: false, code: "invalid", detail: null }, expect.stringContaining("only APPROVED, REJECTED or PAUSED can be")],
    [{ ok: false, code: "graph", detail: "Edit limit reached" }, expect.stringContaining('Meta said: "Edit limit reached"')],
  ] as const)("explains the gateway's %j", async (refusal, message) => {
    await seedA({ results: { editTemplate: refusal } });
    const client = await as();
    const result = await call(client, "template_edit", EDIT);
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.text).toEqual(message);
  });
});

describe("template_delete", () => {
  it("deletes one translation by id and name", async () => {
    await seedA();
    const client = await as();
    const result = await call(client, "template_delete", { templateId: "900300", name: "spring_promo" });
    await client.close();

    expect(result.structuredContent).toEqual({ wabaId: "waba-a", templateId: "900300", name: "spring_promo", deleted: true });
    expect((await writes("deleteTemplate")).map((entry) => entry.input)).toEqual([{ wabaId: "waba-a", templateId: "900300", name: "spring_promo" }]);
    expect(auditLines()).toEqual([expect.objectContaining({ action: "template_delete", resource: { wabaId: null, template: "spring_promo", templateId: "900300" } })]);
  });

  it("says what to check when Meta refuses", async () => {
    await seedA({ results: { deleteTemplate: { ok: false, code: "graph", detail: "Template not found" } } });
    const client = await as();
    const result = await call(client, "template_delete", { templateId: "900300", name: "spring_promo" });
    await client.close();

    expect(result.text).toBe(
      'Meta did not delete template "spring_promo" (id "900300") on WABA "waba-a". Meta said: "Template not found" Call templates_list to check that the id and name belong to the same row.',
    );
  });
});

describe("template_send_test", () => {
  const SEND = { to: "+34 600-000 011", templateName: "order_update", languageCode: "en_US", bodyParams: [" Ana ", "A-1"] };
  const KEY = "8a7c1f0e-3b2d-4c5e-9f6a-1b2c3d4e5f60";

  it("sends from the only phone, with the recipient normalized as the console does", async () => {
    await seedA();
    const client = await as(["view", "send"], ["eccos:view", "eccos:send"]);
    const result = await call(client, "template_send_test", { ...SEND, idempotencyKey: KEY });
    await client.close();

    expect(result.structuredContent).toEqual({
      status: "accepted",
      messageId: "wamid.STUB1",
      wabaId: "waba-a",
      phoneNumberId: "111",
      templateName: "order_update",
      languageCode: "en_US",
    });
    expect((await writes("sendTemplateTest")).map((entry) => entry.input)).toEqual([
      { wabaId: "waba-a", phoneNumberId: "111", to: "34600000011", templateName: "order_update", languageCode: "en_US", bodyParams: ["Ana", "A-1"], idempotencyKey: KEY },
    ]);
    const [audit] = auditLines();
    expect(audit).toMatchObject({ action: "template_send_test", resource: { wabaId: null, phoneNumberId: null, template: "order_update", language: "en_US" }, outcome: "success" });
    expect(JSON.stringify(lines)).not.toMatch(/34600000011|600-000|Ana/);
  });

  it("challenges a send-only grant for eccos:view, which finding the account's WABA needs, as in the console", async () => {
    await seedA();
    const token = await grantToken(makeActor({ actions: ["send"] }), ["eccos:send"]);
    const response = await postMcp(toolsCall("template_send_test", SEND), { token });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope", scope="eccos:view"');
    expect(await gatewayStub.calls()).toEqual([]);
  });

  it("fills a media header and a dynamic URL button", async () => {
    await seedA();
    const client = await as();
    const result = await call(client, "template_send_test", {
      to: "34600000011",
      templateName: "track_link",
      languageCode: "en_US",
      buttonParams: [{ index: 0, text: "A-1" }],
      headerMedia: { format: "image", link: "https://cdn.example/p.jpg" },
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect((await writes("sendTemplateTest"))[0]?.input).toMatchObject({
      buttonParams: [{ index: 0, text: "A-1" }],
      headerMedia: { format: "image", link: "https://cdn.example/p.jpg" },
    });
  });

  it.each([
    [{ bodyParams: ["Ana"] }, 'Template "order_update" (en_US) does not match: it takes exactly 2 bodyParams and 1 were given. Nothing was sent; fix the arguments and call template_send_test again.'],
    [{ buttonParams: [{ index: 0, text: "x" }] }, 'Template "order_update" (en_US) does not match: it has no dynamic URL button, so it takes no buttonParams. Nothing was sent; fix the arguments and call template_send_test again.'],
    [{ headerMedia: { format: "image", link: "https://cdn.example/p.jpg" } }, expect.stringContaining("its header carries no media, so it takes no headerMedia")],
    [{ templateName: "spring_promo", languageCode: "es", bodyParams: [] }, 'Template "spring_promo" (es) cannot be sent from here: Its status is REJECTED; only an APPROVED template can be sent. Nothing was sent.'],
    [{ templateName: "login_code" }, expect.stringContaining("Authentication templates carry a one-time code")],
    [{ templateName: "missing" }, 'WABA "waba-a" has no template "missing" in en_US. Nothing was sent. Call templates_list to see its templates and languages.'],
    [{ to: "12" }, expect.stringContaining("to must be a phone number in international format")],
    [{ bodyParams: ["Ana", "two\nlines"] }, "Refused before reaching Meta: template parameters cannot contain line breaks. Fix it and call template_send_test again."],
    [{ phoneNumberId: "999" }, "Phone number id 999 is not registered in this workspace. Call numbers_list to see every phone with its WABA."],
  ])("refuses before sending anything: %j", async (change, message) => {
    await seedA();
    const client = await as();
    const result = await call(client, "template_send_test", { ...SEND, ...change });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.text).toEqual(message);
    expect(await writes("sendTemplateTest")).toEqual([]);
  });

  it("needs a phoneNumberId when the WABA has several, and refuses a WABA that is not active", async () => {
    await seedA({ resources: account("acct-a", [activeWaba("waba-a", "acct-a", ["111", "113"])]) });
    const client = await as();
    const ambiguous = await call(client, "template_send_test", SEND);
    const chosen = await call(client, "template_send_test", { ...SEND, phoneNumberId: "113" });
    await client.close();
    await seedA({ resources: account("acct-a", [{ ...activeWaba("waba-a", "acct-a", ["111"]), status: "pending" }]) });
    const again = await as();
    const pending = await call(again, "template_send_test", SEND);
    await again.close();

    expect(ambiguous.text).toBe("WABA waba-a has 2 phone numbers: 111, 113. Call again with phoneNumberId set to one of them.");
    expect(chosen.structuredContent).toMatchObject({ phoneNumberId: "113" });
    expect(pending.text).toBe(
      "WABA waba-a is still being set up, so nothing can be sent from it yet. Call numbers_list to follow its provisioning, or number_recheck if it stays pending.",
    );
  });

  it.each([
    ["rate_limited", "Nothing was sent: this WhatsApp Business account reached its Eccos send rate limit, which it shares with the API and the console. Wait a minute before sending again, and do not retry in a loop."],
    ["recipient_not_allowlisted", expect.stringContaining("only sends to numbers on its allowed list")],
    ["template_not_found", 'Nothing was sent: Meta has no approved translation of "order_update" in en_US. Call templates_list to check its status and languages.'],
    ["parameter_mismatch", expect.stringContaining("Meta expected different parameters")],
    ["in_progress", expect.stringContaining("has not settled")],
    ["unknown", "Meta did not confirm this send, so it may already have been sent. Retry later with the same idempotencyKey, which never sends twice."],
    ["key_reused", "Nothing was sent: this idempotencyKey was already used for a different message. Use a new UUID for a new message."],
    ["graph", 'Meta refused the send. Meta said: "(#131026) Message undeliverable" Nothing was sent; tell the person if it is not something you can fix.'],
  ] as const)("turns the gateway's %s into an actionable error", async (code, message) => {
    const detail = code === "graph" ? "(#131026) Message undeliverable" : null;
    await seedA({ results: { sendTemplateTest: { ok: false, code, detail } } });
    const client = await as();
    const result = await call(client, "template_send_test", { ...SEND, idempotencyKey: KEY });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.text).toEqual(message);
    expect(auditLines()).toEqual([expect.objectContaining({ action: "template_send_test", outcome: "failed", detail: code })]);
  });

  it("warns against a blind retry of an unconfirmed send without a key", async () => {
    await seedA({ results: { sendTemplateTest: { ok: false, code: "unknown", detail: null } } });
    const client = await as();
    const result = await call(client, "template_send_test", SEND);
    await client.close();

    expect(result.text).toBe(
      "Meta did not confirm this send, so it may already have been sent. Do not send again until the person confirms it did not arrive; next time pass an idempotencyKey so a retry is safe.",
    );
  });
});

describe("template tools: role and scope", () => {
  const TEMPLATE_TOOLS = ["template_create", "template_delete", "template_edit", "template_send_test", "templates_list"];
  const listed = async (actions: readonly string[]) => {
    const client = await connect(await grantToken(makeActor({ actions: actions as never })));
    const { tools } = await client.listTools();
    await client.close();
    return tools.filter((tool) => TEMPLATE_TOOLS.includes(tool.name));
  };

  it("lists each tool only to an actor with its action", async () => {
    expect((await listed(["view"])).map((tool) => tool.name).sort()).toEqual(["templates_list"]);
    expect((await listed(["view", "operate", "send"])).map((tool) => tool.name).sort()).toEqual(["template_send_test", "templates_list"]);
    expect((await listed(["view", "configure"])).map((tool) => tool.name).sort()).toEqual(["template_create", "template_delete", "template_edit", "templates_list"]);
  });

  it("annotates reads, writes and the destructive delete", async () => {
    const tools = Object.fromEntries((await listed(["view", "send", "configure"])).map((tool) => [tool.name, tool.annotations]));
    expect(tools).toEqual({
      templates_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      template_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      template_edit: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      template_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      template_send_test: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    });
  });

  it.each([
    ["templates_list", "eccos:view", ["eccos:send"]],
    ["template_create", "eccos:configure", ["eccos:view"]],
    ["template_edit", "eccos:configure", ["eccos:view", "eccos:send"]],
    ["template_delete", "eccos:configure", ["eccos:view"]],
    ["template_send_test", "eccos:send", ["eccos:view", "eccos:configure"]],
  ])("challenges %s for %s when the grant lacks it", async (name, needed, granted) => {
    const token = await grantToken(makeActor(), granted);
    const response = await postMcp(toolsCall(name, {}), { token });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(`error="insufficient_scope", scope="${needed}"`);
    expect(await gatewayStub.calls()).toEqual([]);
  });
});

describe("template tools: two accounts", () => {
  const foreign: [string, Record<string, unknown>][] = [
    ["templates_list", { wabaId: "waba-b" }],
    ["template_create", { ...CREATE, wabaId: "waba-b" }],
    ["template_edit", { wabaId: "waba-b", templateId: "800100", name: "b_private", language: "en_US", bodyText: "Hi", bodyExamples: [] }],
    ["template_delete", { wabaId: "waba-b", templateId: "800100", name: "b_private" }],
    ["template_send_test", { wabaId: "waba-b", to: "34600000011", templateName: "b_private", languageCode: "en_US", bodyParams: ["a", "b"] }],
    ["template_send_test", { phoneNumberId: "222", to: "34600000011", templateName: "b_private", languageCode: "en_US", bodyParams: ["a", "b"] }],
  ];

  it.each(foreign)("refuses %s with account B's ids and never calls the gateway for B", async (name, args) => {
    await seedA();
    await seedB();
    const client = await as();
    const result = await call(client, name, args);
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/is not (connected to|registered in) this workspace/);
    expect(result.text).not.toMatch(/acct-b|b_private|800100/);
    const calls = await gatewayStub.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((entry) => entry.accountId === "acct-a")).toBe(true);
    expect(calls.map((entry) => entry.method)).toEqual(["listAccountResources"]);
  });
});
