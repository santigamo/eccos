import type { BillingResult } from "@eccos/console-contract";
import type { AccountWabaResource, TemplatesResult } from "@eccos/gateway-contract";
import { selectWaba } from "@eccos/gateway-contract/select-waba";
import { z } from "zod";
import { SCOPE_OF } from "../permissions";
import { type NextTool, holders, offer } from "./next";
import { type ToolDeps, actorRef, defineTool, isElevated } from "./registry";

const STEP_IDS = ["subscription", "number", "webhook", "api_key", "template"] as const;
const step = z.object({
  id: z.enum(STEP_IDS),
  state: z.enum(["done", "in_progress", "todo", "not_applicable", "unknown"]),
  /** Numbers on active WABAs, active API keys, approved templates; null where nothing is counted. */
  count: z.number().int().nullable(),
  detail: z.string(),
  /** The tool that makes progress on this step, when this connection may call it; else null. */
  nextTool: z.string().nullable(),
  /** A step that must be done first. */
  blockedBy: z.enum(STEP_IDS).nullable(),
});

type Step = z.infer<typeof step>;

/** A step before it is told who may act on it: `fact` says where it stands, `call` how `nextTool` moves it. */
type Draft = Omit<Step, "detail" | "nextTool"> & { fact: string; next?: { tool: NextTool; call?: string } };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const toStep = ({ fact, next, ...rest }: Draft, deps: ToolDeps): Step => ({ ...rest, ...offer(deps, fact, next) });

/** `null` when this connection may not see billing (contract § 4: billing state is administer). */
function subscriptionStep(result: BillingResult | null): Draft {
  const base = { id: "subscription", count: null, blockedBy: null } as const;
  if (result === null) {
    return {
      ...base,
      state: "unknown",
      fact: `Billing needs the ${SCOPE_OF.administer} scope, held by ${holders("administer")}, so it is not shown to this connection.`,
    };
  }
  if (!result.ok) {
    switch (result.code) {
      case "billing_disabled":
        return { ...base, state: "not_applicable", fact: "This deployment runs without billing, so no subscription is needed." };
      case "forbidden":
        return {
          ...base,
          state: "unknown",
          fact: "Billing is visible only to owners and admins of this workspace. Ask one of them whether a subscription is active.",
        };
      default:
        return {
          ...base,
          state: "unknown",
          fact: "Billing could not be read because this connection no longer stands. Ask the person to connect the agent again.",
        };
    }
  }
  if (result.billing.connectPolicy === "open") return { ...base, state: "done", fact: "Billing is active: numbers can be added." };
  return {
    ...base,
    state: "todo",
    fact: "A subscription is required before a number can be connected.",
    next: { tool: "billing_checkout_link", call: "Call billing_checkout_link and give the person the link." },
  };
}

/** The console's rule (lib/setup-checklist.ts): done with an active WABA, in progress with any WABA. */
function numberStep(wabas: AccountWabaResource[], subscription: Draft): Draft {
  const active = wabas.filter((waba) => waba.status === "active");
  const count = active.reduce((sum, waba) => sum + waba.phones.length, 0);
  if (active.length > 0) {
    return { id: "number", count, state: "done", fact: `${plural(count, "number is", "numbers are")} connected and active.`, blockedBy: null };
  }
  if (wabas.length > 0) {
    return {
      id: "number",
      count,
      state: "in_progress",
      fact: "A WhatsApp Business account is connected but no number is active yet.",
      next: { tool: "numbers_list", call: "Call numbers_list to see its provisioning status." },
      blockedBy: null,
    };
  }
  return {
    id: "number",
    count,
    state: "todo",
    fact: "No WhatsApp number is connected.",
    next: {
      tool: "connect_link_create",
      call: "Call connect_link_create and give the person the link; they connect a number through Embedded Signup.",
    },
    blockedBy: subscription.state === "todo" ? "subscription" : null,
  };
}

function webhookStep(wabaId: string | null, url: string | null): Draft {
  const base = { id: "webhook", count: null } as const;
  if (wabaId === null) {
    return {
      ...base,
      state: "todo",
      fact: "No forwarding target can be set until a WhatsApp Business account is connected.",
      next: { tool: "webhook_set" },
      blockedBy: "number",
    };
  }
  if (url !== null) return { ...base, state: "done", fact: `Events from WABA ${wabaId} are forwarded to its subscriber URL.`, blockedBy: null };
  return {
    ...base,
    state: "todo",
    fact: `No subscriber URL is set for WABA ${wabaId}, so inbound events are held.`,
    next: { tool: "webhook_set", call: "Call webhook_set with the URL that should receive them." },
    blockedBy: null,
  };
}

/** A count only, a view fact (design § 4); listing or creating keys is administer. */
function apiKeyStep(active: number): Draft {
  const base = { id: "api_key", count: active, blockedBy: null } as const;
  if (active > 0) return { ...base, state: "done", fact: `${plural(active, "active API key", "active API keys")}.` };
  return {
    ...base,
    state: "todo",
    fact: "No active API key.",
    next: { tool: "api_key_create", call: "Call api_key_create to issue one for the /v1 API." },
  };
}

/** Meta's template list (`data.data`), counted the way the console decides a template can be sent. */
function approvedTemplates(result: TemplatesResult): number | null {
  if (!result.ok) return null;
  const rows = (result.data as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return 0;
  return rows.filter((row) => String((row as { status?: unknown })?.status ?? "").toUpperCase() === "APPROVED").length;
}

function templateStep(wabaId: string | null, approved: number | null): Draft {
  const base = { id: "template" } as const;
  if (wabaId === null) {
    return {
      ...base,
      state: "todo",
      count: 0,
      fact: "No message template can be created until a WhatsApp Business account is connected.",
      next: { tool: "template_create" },
      blockedBy: "number",
    };
  }
  if (approved === null) {
    return {
      ...base,
      state: "unknown",
      count: null,
      fact: "Templates could not be read from Meta just now. Call workspace_get again later.",
      blockedBy: null,
    };
  }
  if (approved > 0) {
    return {
      ...base,
      state: "done",
      count: approved,
      fact: `${plural(approved, "approved template", "approved templates")} on WABA ${wabaId}.`,
      blockedBy: null,
    };
  }
  return {
    ...base,
    state: "todo",
    count: 0,
    fact: `No approved message template on WABA ${wabaId}.`,
    next: { tool: "template_create", call: "Call template_create; Meta reviews a template before it can be sent." },
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
    "API key and an approved message template. Each missing step names the tool to call next (nextTool) when this connection may call it,",
    "says who can do it otherwise, and names any step it waits on (blockedBy).",
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
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_input, actor, deps) => {
    const { gateway } = deps.for("view");
    const [billing, resources, keys] = await Promise.all([
      deps.can("administer") ? deps.for("administer").console.getBilling(actorRef(actor)) : null,
      gateway.listAccountResources(actor.accountId),
      gateway.listApiKeys(actor.accountId),
    ]);
    // The forwarding target's existence is a view fact, as in the console's checklist
    // (server/gateway.ts hasForwardingTarget); the URL itself is never returned.
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
    ].map((draft) => toStep(draft, deps));
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
