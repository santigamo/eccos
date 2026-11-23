import type { BillingResult } from "@eccos/console-contract";
import type { AccountWabaResource, TemplatesResult } from "@eccos/gateway-contract";
import { selectWaba } from "@eccos/gateway-contract/select-waba";
import { z } from "zod";
import { actorRef, defineTool, isElevated } from "./registry";

const STEP_IDS = ["subscription", "number", "webhook", "api_key", "template"] as const;
const step = z.object({
  id: z.enum(STEP_IDS),
  state: z.enum(["done", "in_progress", "todo", "not_applicable", "unknown"]),
  /** Numbers on active WABAs, active API keys, approved templates; null where nothing is counted. */
  count: z.number().int().nullable(),
  detail: z.string(),
  /** The tool that makes progress on this step, or null when there is nothing to do. */
  nextTool: z.string().nullable(),
  /** A step that must be done first. */
  blockedBy: z.enum(STEP_IDS).nullable(),
});

type Step = z.infer<typeof step>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function subscriptionStep(result: BillingResult): Step {
  const base = { id: "subscription", count: null, nextTool: null, blockedBy: null } as const;
  if (!result.ok) {
    switch (result.code) {
      case "billing_disabled":
        return { ...base, state: "not_applicable", detail: "This deployment runs without billing, so no subscription is needed." };
      case "forbidden":
        return {
          ...base,
          state: "unknown",
          detail: "Billing is visible only to owners and admins of this workspace. Ask one of them whether a subscription is active.",
        };
      default:
        return {
          ...base,
          state: "unknown",
          detail: "Billing could not be read because this connection no longer stands. Ask the person to connect the agent again.",
        };
    }
  }
  if (result.billing.connectPolicy === "open") {
    return { ...base, state: "done", detail: "Billing is active: numbers can be added." };
  }
  return {
    ...base,
    state: "todo",
    detail: "A subscription is required before a number can be connected. Call billing_checkout_link and give the person the link.",
    nextTool: "billing_checkout_link",
  };
}

/** The console's rule (lib/setup-checklist.ts): done with an active WABA, in progress with any WABA. */
function numberStep(wabas: AccountWabaResource[], subscription: Step): Step {
  const active = wabas.filter((waba) => waba.status === "active");
  const count = active.reduce((sum, waba) => sum + waba.phones.length, 0);
  const base = { id: "number", count } as const;
  if (active.length > 0) {
    return { ...base, state: "done", detail: `${plural(count, "number is", "numbers are")} connected and active.`, nextTool: null, blockedBy: null };
  }
  if (wabas.length > 0) {
    return {
      ...base,
      state: "in_progress",
      detail: "A WhatsApp Business account is connected but no number is active yet. Call numbers_list to see its provisioning status.",
      nextTool: "numbers_list",
      blockedBy: null,
    };
  }
  return {
    ...base,
    state: "todo",
    detail: "No WhatsApp number is connected. Call connect_link_create and give the person the link; they connect a number through Embedded Signup.",
    nextTool: "connect_link_create",
    blockedBy: subscription.state === "todo" ? "subscription" : null,
  };
}

function webhookStep(wabaId: string | null, url: string | null): Step {
  const base = { id: "webhook", count: null, nextTool: "webhook_set" } as const;
  if (wabaId === null) {
    return { ...base, state: "todo", detail: "No forwarding target can be set until a WhatsApp Business account is connected.", blockedBy: "number" };
  }
  if (url !== null) {
    return { ...base, state: "done", detail: `Events from WABA ${wabaId} are forwarded to its subscriber URL.`, nextTool: null, blockedBy: null };
  }
  return {
    ...base,
    state: "todo",
    detail: `No subscriber URL is set for WABA ${wabaId}, so inbound events are held. Call webhook_set with the URL that should receive them.`,
    blockedBy: null,
  };
}

function apiKeyStep(active: number): Step {
  const base = { id: "api_key", count: active, blockedBy: null } as const;
  if (active > 0) return { ...base, state: "done", detail: `${plural(active, "active API key", "active API keys")}.`, nextTool: null };
  return { ...base, state: "todo", detail: "No active API key. Call api_key_create to issue one for the /v1 API.", nextTool: "api_key_create" };
}

/** Meta's template list (`data.data`), counted the way the console decides a template can be sent. */
function approvedTemplates(result: TemplatesResult): number | null {
  if (!result.ok) return null;
  const rows = (result.data as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return 0;
  return rows.filter((row) => String((row as { status?: unknown })?.status ?? "").toUpperCase() === "APPROVED").length;
}

function templateStep(wabaId: string | null, approved: number | null): Step {
  const base = { id: "template", nextTool: "template_create" } as const;
  if (wabaId === null) {
    return {
      ...base,
      state: "todo",
      count: 0,
      detail: "No message template can be created until a WhatsApp Business account is connected.",
      blockedBy: "number",
    };
  }
  if (approved === null) {
    return {
      ...base,
      state: "unknown",
      count: null,
      detail: "Templates could not be read from Meta just now. Call workspace_get again later.",
      nextTool: null,
      blockedBy: null,
    };
  }
  if (approved > 0) {
    return {
      ...base,
      state: "done",
      count: approved,
      detail: `${plural(approved, "approved template", "approved templates")} on WABA ${wabaId}.`,
      nextTool: null,
      blockedBy: null,
    };
  }
  return {
    ...base,
    state: "todo",
    count: 0,
    detail: `No approved message template on WABA ${wabaId}. Call template_create; Meta reviews a template before it can be sent.`,
    blockedBy: null,
  };
}

export const workspaceGet = defineTool({
  name: "workspace_get",
  action: "view",
  stepUp: false,
  title: "Get the workspace and its setup checklist",
  description: [
    "Returns who you act as in Eccos (user and role), the workspace this connection is bound to, the scopes and actions this connection allows,",
    "whether sensitive actions are approved (elevatedUntil, ISO time or null) and a setup checklist: subscription, WhatsApp number, webhook,",
    "API key and an approved message template. Each missing step names the tool to call next (nextTool) and any step it waits on (blockedBy).",
    "Call this first, and again after each setup step to see what is left. It changes nothing.",
  ].join(" "),
  inputSchema: z.object({}),
  outputSchema: z.object({
    actingAs: z.object({ userId: z.string(), role: z.enum(["owner", "admin", "operator", "viewer"]) }),
    workspace: z.object({ organizationId: z.string() }),
    scopes: z.array(z.string()),
    actions: z.array(z.enum(["view", "operate", "send", "configure", "administer"])),
    elevatedUntil: z.string().nullable(),
    setup: z.object({ complete: z.boolean(), steps: z.array(step) }),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: async (_input, actor, { gateway, console }) => {
    const [billing, resources, keys] = await Promise.all([
      console.getBilling(actorRef(actor)),
      gateway.listAccountResources(actor.accountId),
      gateway.listApiKeys(actor.accountId),
    ]);
    const waba = resources.wabas.length > 0 ? selectWaba(actor.accountId, resources.wabas, undefined, false, "any") : null;
    const [subscriber, templates] = waba
      ? await Promise.all([
          gateway.getSubscriberConfig(waba.wabaId, actor.accountId),
          gateway.listTemplates(waba.wabaId, 100, actor.accountId),
        ])
      : [null, null];

    const subscription = subscriptionStep(billing);
    const steps = [
      subscription,
      numberStep(resources.wabas, subscription),
      webhookStep(waba?.wabaId ?? null, subscriber?.url ?? null),
      apiKeyStep(keys.filter((key) => key.revokedAt === null).length),
      templateStep(waba?.wabaId ?? null, templates ? approvedTemplates(templates) : 0),
    ];
    return {
      actingAs: { userId: actor.userId, role: actor.role },
      workspace: { organizationId: actor.organizationId },
      scopes: actor.scope,
      actions: actor.actions,
      elevatedUntil: actor.elevatedUntil !== null && isElevated(actor) ? new Date(actor.elevatedUntil).toISOString() : null,
      setup: { complete: steps.every((s) => s.state === "done" || s.state === "not_applicable"), steps },
    };
  },
});

