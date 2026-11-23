import type { AccountWabaResource } from "@eccos/gateway-contract";
import { beforeEach, describe, expect, it } from "vitest";
import {
  METADATA_URL,
  accountResources,
  activeWaba,
  call,
  connect,
  errorOf,
  gatewayStub,
  grantToken,
  listedTools,
  makeActor,
  postMcp,
  resetStubs,
  toolsCall,
  wabaIn,
} from "./helpers";

beforeEach(resetStubs);

const owner = () => makeActor();

async function seedA(...wabas: AccountWabaResource[]) {
  await gatewayStub.seed("acct-a", { resources: accountResources("acct-a", wabas) });
}

/** Account B exists next to A with its own WABA; nothing an A actor does may reach it. */
async function seedB() {
  await gatewayStub.seed("acct-b", {
    resources: accountResources("acct-b", [wabaIn("pending", "waba-b", "acct-b", ["900"])]),
    status: {},
  });
}

async function onlyAccountA() {
  const calls = await gatewayStub.calls();
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((entry) => entry.accountId !== "acct-a")).toEqual([]);
}

describe("numbers_list", () => {
  it("says to make a connection link when nothing is connected", async () => {
    await seedA();
    const client = await connect(await grantToken(owner()));
    const result = await call(client, "numbers_list");
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      wabas: [],
      detail: "No WhatsApp number is connected. Call connect_link_create and give the person the link; they connect a number through Embedded Signup.",
      nextTool: "connect_link_create",
    });
  });

  it("names only tools a viewer may call", async () => {
    await seedA(wabaIn("pending", "waba-1", "acct-a", ["111"]));
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] }), ["eccos:view"]));
    const result = (await call(client, "numbers_list")).structuredContent as { wabas: Record<string, unknown>[]; nextTool: unknown };
    await client.close();

    expect(result.nextTool).toBeNull();
    expect(result.wabas[0]).toMatchObject({
      nextTool: null,
      detail:
        "Registered, but Eccos has not finished subscribing it to its Meta webhooks. Eccos keeps retrying on its own. This connection acts for a viewer, and configure needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
    });
  });

  it("lists every WABA with its state, token expiry, coexistence and what to do", async () => {
    const failed = {
      ...wabaIn("failed", "waba-3", "acct-a", ["333"]),
      provisioningError: "subscribed_apps: (#200) Permissions error",
      tokenExpiresAt: null,
    };
    const live = { ...activeWaba("waba-1", "acct-a", ["111"]), tokenExpiresAt: Date.UTC(2027, 0, 1) };
    await seedA(failed, wabaIn("pending", "waba-2", "acct-a", ["222"]), live, wabaIn("active", "waba-4", "acct-a"));
    const client = await connect(await grantToken(owner()));
    const result = await call(client, "numbers_list");
    await client.close();

    const { wabas, detail, nextTool } = result.structuredContent as {
      wabas: Record<string, unknown>[];
      detail: string;
      nextTool: string;
    };
    expect(wabas.map((waba) => [waba.wabaId, waba.status, waba.nextTool])).toEqual([
      ["waba-1", "active", null],
      ["waba-2", "pending", "number_recheck"],
      ["waba-3", "failed", "number_recheck"],
      ["waba-4", "active", "number_recheck"],
    ]);
    expect(wabas[0]).toEqual({
      wabaId: "waba-1",
      status: "active",
      phones: [{ phoneNumberId: "111", displayPhoneNumber: "+34 600 111" }],
      createdAt: "1970-01-01T00:00:00.001Z",
      connectedAt: "1970-01-01T00:00:00.002Z",
      provisioningError: null,
      tokenExpiry: "expires",
      tokenExpiresAt: "2027-01-01T00:00:00.000Z",
      coexistence: { onboardingType: "standard", verifiedOnboardingType: null, status: "not_applicable", historyDeadlineAt: null },
      detail: "Live: it sends and receives messages.",
      nextTool: null,
    });
    expect(wabas[1]).toMatchObject({ tokenExpiry: "never", tokenExpiresAt: null, connectedAt: null });
    expect(wabas[2]).toMatchObject({
      tokenExpiry: "unknown",
      provisioningError: "subscribed_apps: (#200) Permissions error",
      detail: expect.stringMatching(/^This number is not connected: Eccos could not finish the setup\. Call number_recheck/),
    });
    expect(wabas[3]?.detail).toMatch(/no business phone number yet/);
    expect(detail).toBe("1 live number on 4 WhatsApp Business accounts. At least one needs attention: see its detail.");
    expect(nextTool).toBe("number_recheck");
  });

  it("points a failed coexistence onboarding at support, never at reconnecting", async () => {
    const waba = wabaIn("failed", "waba-1", "acct-a", ["111"]);
    waba.coexistence = { ...waba.coexistence, onboardingType: "coexistence", status: "expired", deadlineAt: Date.UTC(2026, 10, 20) };
    await seedA(waba);
    const client = await connect(await grantToken(owner()));
    const [row] = ((await call(client, "numbers_list")).structuredContent as { wabas: Record<string, unknown>[] }).wabas;
    await client.close();

    expect(row).toMatchObject({
      nextTool: null,
      coexistence: { onboardingType: "coexistence", status: "expired", historyDeadlineAt: "2026-11-20T00:00:00.000Z" },
      detail:
        "This number is not connected: the 24-hour window to import its WhatsApp Business app chat history ran out. Do not reconnect it; the person should contact Eccos support.",
    });
  });

  it("reaches only the actor's own account", async () => {
    await seedA(activeWaba("waba-a", "acct-a", ["1"]));
    await seedB();
    const client = await connect(await grantToken(owner()));
    const result = await call(client, "numbers_list");
    await client.close();

    await onlyAccountA();
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/acct-b|waba-b|900/);
  });
});

describe("number_recheck", () => {
  it("re-runs provisioning for the only WABA when no id is given", async () => {
    await gatewayStub.seed("acct-a", {
      resources: accountResources("acct-a", [wabaIn("pending", "waba-1", "acct-a", ["111"])]),
      reconcile: { "waba-1": { ok: true, status: "pending", error: "Meta has not confirmed subscribed_apps" } },
    });
    const client = await connect(await grantToken(makeActor({ role: "admin", actions: ["view", "configure"] }), ["eccos:view", "eccos:configure"]));
    const result = await call(client, "number_recheck");
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      wabaId: "waba-1",
      status: "pending",
      recheckRan: true,
      provisioningError: "Meta has not confirmed subscribed_apps",
      detail: "Meta has not confirmed the webhook subscription yet. Eccos keeps retrying on its own. Call numbers_list in a few minutes.",
      nextTool: "numbers_list",
    });
    expect((await gatewayStub.calls()).map((entry) => entry.method)).toEqual(["listAccountResources", "reconcileWaba"]);
  });

  it("asks which WABA when the workspace has several", async () => {
    await seedA(wabaIn("pending", "waba-2", "acct-a"), wabaIn("failed", "waba-1", "acct-a"));
    const client = await connect(await grantToken(owner()));
    const text = errorOf(await call(client, "number_recheck"));
    await client.close();

    expect(text).toBe(
      "This workspace has 2 WhatsApp Business accounts: waba-1, waba-2. Call again with wabaId set to one of them. Call numbers_list to see the numbers on each.",
    );
    expect((await gatewayStub.calls()).map((entry) => entry.method)).toEqual(["listAccountResources"]);
  });

  it("does nothing for a WABA that is already active with its numbers", async () => {
    await seedA(activeWaba("waba-1", "acct-a", ["111"]));
    const client = await connect(await grantToken(owner()));
    const result = await call(client, "number_recheck", { wabaId: "waba-1" });
    await client.close();

    expect(result.structuredContent).toMatchObject({ status: "active", recheckRan: false, nextTool: null });
    expect((await gatewayStub.calls()).map((entry) => entry.method)).toEqual(["listAccountResources"]);
  });

  it("says what to do when the re-check itself fails", async () => {
    await gatewayStub.seed("acct-a", {
      resources: accountResources("acct-a", [wabaIn("failed", "waba-1", "acct-a")]),
      reconcile: { "waba-1": { ok: false, error: "provisioning is already running" } },
    });
    const client = await connect(await grantToken(owner()));
    const text = errorOf(await call(client, "number_recheck", { wabaId: "waba-1" }));
    await client.close();

    expect(text).toBe(
      "Eccos could not re-check WABA waba-1 just now (provisioning is already running). It keeps retrying on its own; call number_recheck again in a few minutes, and if it keeps failing the person should contact Eccos support.",
    );
  });

  it("is not listed without configure, and challenges a grant without eccos:configure", async () => {
    await seedA(wabaIn("pending", "waba-1", "acct-a"));
    const viewer = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] }), ["eccos:view", "eccos:configure"]));
    expect(await listedTools(viewer)).not.toContain("number_recheck");
    await viewer.close();

    const token = await grantToken(makeActor({ actions: ["view"] }), ["eccos:view"]);
    const response = await postMcp(toolsCall("number_recheck", { wabaId: "waba-1" }), { token });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="OAuth", error="insufficient_scope", scope="eccos:configure", resource_metadata="${METADATA_URL}"`,
    );
    expect(await gatewayStub.calls()).toEqual([]);
  });

  it("needs view to read the account's WABAs, and says so to a configure-only connection", async () => {
    await seedA(wabaIn("pending", "waba-a", "acct-a"));
    const client = await connect(await grantToken(makeActor({ role: "admin", actions: ["configure"] }), ["eccos:configure"]));
    const text = errorOf(await call(client, "number_recheck", { wabaId: "waba-a" }));
    await client.close();

    expect(text).toBe("This connection was not granted the eccos:view scope that view needs. Ask the person to connect the agent again and grant it.");
    expect(await gatewayStub.calls()).toEqual([]);
  });

  it("refuses a WABA of another account and never calls the gateway for it", async () => {
    await seedA(wabaIn("pending", "waba-a", "acct-a"));
    await seedB();
    const client = await connect(await grantToken(owner()));
    const text = errorOf(await call(client, "number_recheck", { wabaId: "waba-b" }));
    await client.close();

    expect(text).toBe("WABA waba-b is not connected to this workspace. Its WABAs are: waba-a. Call numbers_list to see them.");
    await onlyAccountA();
    expect((await gatewayStub.calls()).map((entry) => entry.method)).toEqual(["listAccountResources"]);
  });
});

describe("status_get", () => {
  const STATUS = {
    name: "eccos",
    version: "0.1.0",
    health: "degraded" as const,
    connection: { wabaId: "waba-1", phoneNumberId: "111", displayPhone: "+34 600 111", connectedAt: "2026-11-20T10:00:00.000Z" },
    counts: { inbound: 3, inboundByType: { reply: 1, delivered: 2 }, outbound: { sent: 4, failed: 1 }, deliveries: { delivered: 3 } },
  };

  it("returns the health and counters of the only active WABA", async () => {
    await gatewayStub.seed("acct-a", { resources: accountResources("acct-a", [activeWaba("waba-1", "acct-a", ["111"])]), status: { "waba-1": STATUS } });
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] }), ["eccos:view"]));
    const result = await call(client, "status_get");
    await client.close();

    expect(result.structuredContent).toEqual({
      wabaId: "waba-1",
      health: "degraded",
      detail:
        "Degraded: more than 10 events are waiting to be forwarded, or a message sent to Meta failed. Check the webhook target and recent sends.",
      phoneNumberId: "111",
      displayPhoneNumber: "+34 600 111",
      connectedAt: "2026-11-20T10:00:00.000Z",
      counts: STATUS.counts,
    });
  });

  it("tells a viewer with no WABA who can connect one", async () => {
    await seedA();
    const client = await connect(await grantToken(makeActor({ role: "viewer", actions: ["view"] }), ["eccos:view"]));
    const text = errorOf(await call(client, "status_get"));
    await client.close();

    expect(text).toBe(
      "No WhatsApp Business account is connected to this workspace yet. This connection acts for a viewer, and administer needs an admin or above in this workspace. Ask such a person to do this in the Eccos console.",
    );
  });

  it("sends a WABA that is not active to numbers_list", async () => {
    await seedA(wabaIn("pending", "waba-1", "acct-a"));
    const client = await connect(await grantToken(owner()));
    const text = errorOf(await call(client, "status_get", { wabaId: "waba-1" }));
    await client.close();

    expect(text).toBe("WABA waba-1 is pending, not active, so it has no status yet. Call numbers_list to see why and what to do.");
    expect((await gatewayStub.calls()).map((entry) => entry.method)).toEqual(["listAccountResources"]);
  });

  it("refuses a WABA of another account and never calls the gateway for it", async () => {
    await seedA(activeWaba("waba-a", "acct-a", ["1"]));
    await gatewayStub.seed("acct-b", { resources: accountResources("acct-b", [activeWaba("waba-b", "acct-b", ["2"])]) });
    const client = await connect(await grantToken(owner()));
    const text = errorOf(await call(client, "status_get", { wabaId: "waba-b" }));
    await client.close();

    expect(text).toMatch(/^WABA waba-b is not connected to this workspace\. Its WABAs are: waba-a\./);
    await onlyAccountA();
  });

  it("is not listed and is challenged without view", async () => {
    const operator = await connect(await grantToken(makeActor({ role: "operator", actions: ["operate"] }), ["eccos:operate"]));
    expect(await listedTools(operator)).toEqual([]);
    await operator.close();

    const response = await postMcp(toolsCall("status_get"), { token: await grantToken(makeActor({ actions: ["operate"] }), ["eccos:operate"]) });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="eccos:view"');
  });
});
