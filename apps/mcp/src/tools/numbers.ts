import type { AccountWabaResource, CoexistenceResource } from "@eccos/gateway-contract";
import { z } from "zod";
import { offer } from "./next";
import { ToolError, type ToolDeps, defineTool } from "./registry";
import { isoTime, ownedWaba, wabaIdInput } from "./scope";

const UNAVAILABLE_REASON = /^unavailable:(already_synced|history_sharing_off|not_permitted)$/;

const SYNC_NOUN = {
  contacts: "Its WhatsApp Business app contacts were",
  history: "Its WhatsApp Business app chat history was",
} as const;

const REASON_COPY = {
  already_synced:
    "not imported: Meta allows that import once per number, and it was already used. To repeat it, the person should contact Eccos support.",
  history_sharing_off: "not imported: history sharing was off in the app when the number was connected.",
  not_permitted: "not imported: Meta did not allow it for this number. The person should contact Eccos support.",
} as const;

/** The console's `syncUnavailableCopy` (lib/provisioning-copy.ts): one sentence per sync Meta refused. */
function syncUnavailable(coexistence: CoexistenceResource): string {
  const lines = (["contacts", "history"] as const).flatMap((kind) => {
    const requestId = kind === "contacts" ? coexistence.contactsRequestId : coexistence.historyRequestId;
    const reason = requestId?.match(UNAVAILABLE_REASON)?.[1] as keyof typeof REASON_COPY | undefined;
    return reason ? [`${SYNC_NOUN[kind]} ${REASON_COPY[reason]}`] : [];
  });
  return lines.length > 0 ? lines.join(" ") : "Some WhatsApp Business app data was not imported. The person should contact Eccos support.";
}

/**
 * What to tell the agent about one WABA, keyed on structured state exactly as the console's
 * Numbers page is (lib/provisioning-copy.ts, numbers-table.tsx), never on `provisioningError`.
 */
function wabaGuidance(waba: AccountWabaResource, deps: ToolDeps): { detail: string; nextTool: string | null } {
  const { coexistence } = waba;
  if (waba.status === "failed") {
    const subject = waba.phones.length > 0 ? "This number is" : "This WhatsApp Business account is";
    // Once a once-only import was requested, connecting again would re-issue it: support only.
    if (coexistence.status === "expired") {
      return {
        detail: `${subject} not connected: the 24-hour window to import its WhatsApp Business app chat history ran out. Do not reconnect it; the person should contact Eccos support.`,
        nextTool: null,
      };
    }
    if (coexistence.status === "unconfirmed" || coexistence.contactsStartedAt !== null || coexistence.historyStartedAt !== null) {
      return {
        detail: `${subject} not connected: Eccos started importing its WhatsApp Business app data and could not confirm it finished. Do not reconnect it; the person should contact Eccos support.`,
        nextTool: null,
      };
    }
    return offer(deps, `${subject} not connected: Eccos could not finish the setup.`, {
      tool: "number_recheck",
      call: "Call number_recheck to retry it. If it stays failed, the person connects it again through a new connection link (connect_link_create with replace: true); if that fails too, they should contact Eccos support.",
    });
  }
  if (waba.status === "pending") {
    return offer(deps, "Registered, but Eccos has not finished subscribing it to its Meta webhooks. Eccos keeps retrying on its own.", {
      tool: "number_recheck",
      call: "Call number_recheck to run that now.",
    });
  }
  if (waba.phones.length === 0) {
    return offer(
      deps,
      "Connected, but this WhatsApp Business account has no business phone number yet. The person adds one in WhatsApp Manager and Eccos picks it up on its own within minutes; nothing needs reconnecting.",
      { tool: "number_recheck", call: "Call number_recheck once they have added it to check now." },
    );
  }
  if (coexistence.status === "not_coexistence") {
    return {
      detail:
        "Live. It was connected as a WhatsApp Business app number, but Meta reports it is not one, so its app contacts and chat history were not imported and will not be.",
      nextTool: null,
    };
  }
  if (coexistence.status === "unavailable") return { detail: `Live. ${syncUnavailable(coexistence)}`, nextTool: null };
  return { detail: "Live: it sends and receives messages.", nextTool: null };
}

const provisioningStatus = z.enum(["pending", "active", "failed"]);

const wabaOutput = z.object({
  wabaId: z.string(),
  status: provisioningStatus,
  phones: z.array(z.object({ phoneNumberId: z.string(), displayPhoneNumber: z.string() })),
  createdAt: z.string(),
  /** When provisioning last completed; null until it has. */
  connectedAt: z.string().nullable(),
  provisioningError: z
    .string()
    .nullable()
    .describe("Eccos's technical note on why provisioning did not complete, for Eccos support. Act on detail and nextTool instead."),
  tokenExpiry: z.enum(["never", "expires", "unknown"]),
  tokenExpiresAt: z.string().nullable(),
  coexistence: z.object({
    onboardingType: z.enum(["standard", "coexistence"]),
    verifiedOnboardingType: z.enum(["standard", "coexistence"]).nullable(),
    status: z.enum(["not_applicable", "pending", "initiated", "unconfirmed", "unavailable", "not_coexistence", "expired"]),
    historyDeadlineAt: z.string().nullable(),
  }),
  detail: z.string(),
  nextTool: z.string().nullable(),
});

export const numbersList = defineTool({
  name: "numbers_list",
  action: "view",
  stepUp: false,
  title: "List connected WhatsApp numbers",
  description: [
    "Lists the WhatsApp Business accounts (WABAs) connected to this workspace and the phone numbers on each, with provisioning status",
    "(pending, active or failed), coexistence state for numbers that also run the WhatsApp Business app, and when the stored Meta token expires.",
    "Each WABA carries detail (what its state means) and nextTool (number_recheck for one that is pending, failed or still has no number; null when nothing is needed).",
    "Use it after a person has used a connection link, to follow provisioning, and to find the wabaId other tools take. It changes nothing.",
  ].join(" "),
  inputSchema: z.object({}),
  outputSchema: z.object({
    wabas: z.array(wabaOutput),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_input, actor, deps) => {
    const { gateway } = deps.for("view");
    const { wabas } = await gateway.listAccountResources(actor.accountId);
    if (wabas.length === 0) {
      return {
        wabas: [],
        ...offer(deps, "No WhatsApp number is connected.", {
          tool: "connect_link_create",
          call: "Call connect_link_create and give the person the link; they connect a number through Embedded Signup.",
        }),
      };
    }
    const rows = [...wabas]
      .sort((a, b) => a.wabaId.localeCompare(b.wabaId))
      .map((waba) => ({
        wabaId: waba.wabaId,
        status: waba.status,
        phones: waba.phones.map(({ phoneNumberId, displayPhoneNumber }) => ({ phoneNumberId, displayPhoneNumber })),
        createdAt: new Date(waba.createdAt).toISOString(),
        connectedAt: isoTime(waba.provisionedAt),
        provisioningError: waba.provisioningError,
        tokenExpiry: waba.tokenExpiresAt === 0 ? ("never" as const) : waba.tokenExpiresAt === null ? ("unknown" as const) : ("expires" as const),
        tokenExpiresAt: waba.tokenExpiresAt ? isoTime(waba.tokenExpiresAt) : null,
        coexistence: {
          onboardingType: waba.coexistence.onboardingType,
          verifiedOnboardingType: waba.coexistence.verifiedOnboardingType,
          status: waba.coexistence.status,
          historyDeadlineAt: isoTime(waba.coexistence.deadlineAt),
        },
        ...wabaGuidance(waba, deps),
      }));
    const live = rows.filter((row) => row.status === "active").reduce((sum, row) => sum + row.phones.length, 0);
    const waiting = rows.find((row) => row.nextTool !== null);
    return {
      wabas: rows,
      detail: `${live} live ${live === 1 ? "number" : "numbers"} on ${rows.length} WhatsApp Business ${rows.length === 1 ? "account" : "accounts"}.${
        waiting ? " At least one needs attention: see its detail." : ""
      }`,
      nextTool: waiting?.nextTool ?? null,
    };
  },
});

export const numberRecheck = defineTool({
  name: "number_recheck",
  action: "configure",
  stepUp: false,
  title: "Re-check a WhatsApp number's setup",
  description: [
    "Re-runs Eccos's setup for one WhatsApp Business account (WABA) now: subscribing it to Meta's webhooks and picking up phone numbers added in WhatsApp Manager.",
    "Use it when numbers_list shows the WABA pending, failed, or without a phone number; Eccos also retries on its own every few minutes, so this only saves the wait.",
    "Safe to repeat. Returns the status afterwards; call numbers_list to see the numbers and what each state means.",
  ].join(" "),
  inputSchema: z.object({ wabaId: wabaIdInput }),
  outputSchema: z.object({
    wabaId: z.string(),
    status: provisioningStatus,
    recheckRan: z.boolean(),
    provisioningError: z.string().nullable().describe("Eccos's technical note, for Eccos support. Act on detail and nextTool instead."),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  audit: (input) => ({ wabaId: input.wabaId ?? null }),
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("configure");
    const waba = await ownedWaba(deps, gateway, actor.accountId, input.wabaId);
    // The console offers Re-check only where it can change something (numbers-table.tsx).
    if (waba.status === "active" && waba.phones.length > 0) {
      return {
        wabaId: waba.wabaId,
        status: waba.status,
        recheckRan: false,
        provisioningError: null,
        detail: `WABA ${waba.wabaId} is already active with its numbers, so there is nothing to re-check.`,
        nextTool: null,
      };
    }
    const result = await gateway.reconcileWaba(waba.wabaId, actor.accountId);
    if (!result.ok) {
      throw new ToolError(
        `Eccos could not re-check WABA ${waba.wabaId} just now (${result.error}). It keeps retrying on its own; call number_recheck again in a few minutes, and if it keeps failing the person should contact Eccos support.`,
      );
    }
    const next = {
      active: [`WABA ${waba.wabaId} is active.`, "Call numbers_list to see its numbers."],
      pending: ["Meta has not confirmed the webhook subscription yet. Eccos keeps retrying on its own.", "Call numbers_list in a few minutes."],
      failed: ["This number could not be connected.", "Call numbers_list for what to do next."],
    }[result.status] as [string, string];
    return {
      wabaId: waba.wabaId,
      status: result.status,
      recheckRan: true,
      provisioningError: result.error,
      ...offer(deps, next[0], { tool: "numbers_list", call: next[1] }),
    };
  },
});

const HEALTH_DETAIL = {
  healthy: "Healthy: no failed forwards, no failed sends, and the forwarding queue is short.",
  degraded:
    "Degraded: more than 10 events are waiting to be forwarded, or a message sent to Meta failed. Check the webhook target and recent sends.",
  unhealthy: "Unhealthy: at least one event could not be forwarded to the webhook target. Check that the target answers 2xx.",
} as const;

const counter = z.record(z.string(), z.number());

export const statusGet = defineTool({
  name: "status_get",
  action: "view",
  stepUp: false,
  title: "Get a WhatsApp number's health and counters",
  description: [
    "Returns the health (healthy, degraded or unhealthy) of one active WhatsApp Business account (WABA) and its counters: inbound events by type,",
    "outbound messages by status and forwards to the webhook target by status. Use it to confirm a number works after setup, or to see why",
    "events are not arriving. A WABA that is not active yet has no status: call numbers_list instead. It changes nothing.",
  ].join(" "),
  inputSchema: z.object({ wabaId: wabaIdInput }),
  outputSchema: z.object({
    wabaId: z.string(),
    health: z.enum(["healthy", "degraded", "unhealthy"]),
    detail: z.string(),
    phoneNumberId: z.string().nullable(),
    displayPhoneNumber: z.string().nullable(),
    connectedAt: z.string().nullable(),
    counts: z.object({ inbound: z.number(), inboundByType: counter, outbound: counter, deliveries: counter }),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (input, actor, deps) => {
    const { gateway } = deps.for("view");
    const waba = await ownedWaba(deps, gateway, actor.accountId, input.wabaId);
    if (waba.status !== "active") {
      throw new ToolError(
        `WABA ${waba.wabaId} is ${waba.status}, not active, so it has no status yet. Call numbers_list to see why and what to do.`,
      );
    }
    const status = await gateway.getStatus(waba.wabaId, actor.accountId);
    return {
      wabaId: waba.wabaId,
      health: status.health,
      detail: HEALTH_DETAIL[status.health],
      phoneNumberId: status.connection.phoneNumberId,
      displayPhoneNumber: status.connection.displayPhone,
      connectedAt: status.connection.connectedAt,
      counts: {
        inbound: status.counts.inbound,
        inboundByType: status.counts.inboundByType ?? {},
        outbound: status.counts.outbound,
        deliveries: status.counts.deliveries,
      },
    };
  },
});
