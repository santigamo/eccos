import type { BillingRefusalCode } from "@eccos/console-contract";
import { BILLING_STATUSES, blocksSends } from "@eccos/gateway-contract/billing-status";
import { z } from "zod";
import { GRANT_REFUSED, ToolError, actorRef, defineTool } from "./registry";

const FORBIDDEN =
  "Billing is visible only to owners and admins of this workspace, and the person this agent acts for is no longer one. Ask an owner or admin to check billing in the Eccos console.";

const BILLING_DISABLED =
  "This Eccos deployment runs without billing, so no subscription is needed and there is no checkout. Call connect_link_create to connect a number.";

const refusal = (code: Exclude<BillingRefusalCode, "billing_disabled">) => (code === "forbidden" ? FORBIDDEN : GRANT_REFUSED[code]);

export const billingGet = defineTool({
  name: "billing_get",
  action: "administer",
  reads: [],
  stepUp: false,
  title: "Get the workspace's billing",
  description: [
    "Returns whether this workspace can add a WhatsApp number now (connectPolicy open) or needs a subscription first (closed), its billing status,",
    "how many numbers are billed and the monthly price in euros. The first number needs no subscription; a second one does. Sending stops only while",
    "the status is paused or closed. enabled is false when the deployment runs without billing.",
    "Call it before connect_link_create, and after the person pays to confirm numbers can be added; nextTool says what to call next. It changes nothing.",
  ].join(" "),
  inputSchema: z.object({}),
  outputSchema: z.object({
    enabled: z.boolean(),
    connectPolicy: z.enum(["open", "closed"]).nullable(),
    status: z.enum(BILLING_STATUSES).nullable(),
    numbers: z.number().int().nullable(),
    monthlyEuros: z.number().nullable(),
    hasBillingAccount: z.boolean().nullable(),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_input, actor, deps) => {
    const { console } = deps.for("administer");
    const result = await console.getBilling(actorRef(actor));
    if (!result.ok) {
      if (result.code !== "billing_disabled") throw new ToolError(refusal(result.code));
      return {
        enabled: false,
        connectPolicy: null,
        status: null,
        numbers: null,
        monthlyEuros: null,
        hasBillingAccount: null,
        detail: "This deployment runs without billing, so no subscription is needed.",
        nextTool: null,
      };
    }
    const { billing } = result;
    const priced = `${billing.numbers} ${billing.numbers === 1 ? "number is" : "numbers are"} billed, ${billing.monthlyEuros} euros a month.`;
    const sending = blocksSends(billing.billingStatus)
      ? "numbers already connected cannot send until it is active"
      : "numbers already connected keep sending";
    return {
      enabled: true,
      connectPolicy: billing.canAddNumber ? ("open" as const) : ("closed" as const),
      status: billing.billingStatus,
      numbers: billing.numbers,
      monthlyEuros: billing.monthlyEuros,
      hasBillingAccount: billing.hasCustomer,
      ...(billing.canAddNumber
        ? { detail: `Numbers can be added. ${priced}`, nextTool: null }
        : {
            detail: `A subscription is required before a number can be added; ${sending}. ${priced} Call billing_checkout_link and give the person the link.`,
            nextTool: "billing_checkout_link",
          }),
    };
  },
});

export const billingCheckoutLink = defineTool({
  name: "billing_checkout_link",
  action: "administer",
  reads: [],
  stepUp: false,
  title: "Get a link to subscribe or manage billing",
  description: [
    "Returns a payment page link for a person to open in a browser; you cannot pay yourself. With purpose subscribe (the default) it is the checkout",
    "for a subscription priced per connected number, or the billing portal when the workspace already has a live subscription (kind says which).",
    "With purpose manage it is the billing portal, to change the card, see invoices or cancel. Give the url to an owner or admin of the workspace,",
    "then call billing_get after they finish to confirm numbers can be added.",
  ].join(" "),
  inputSchema: z.object({
    purpose: z
      .enum(["subscribe", "manage"])
      .default("subscribe")
      .describe("subscribe: start a subscription (the portal if one is live). manage: the portal of an existing billing account."),
  }),
  outputSchema: z.object({
    kind: z.enum(["checkout", "portal"]),
    url: z.string().describe("The page for a person to open. It is not for the agent to fetch."),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  audit: (input) => ({ purpose: input.purpose }),
  run: async (input, actor, deps) => {
    const { console } = deps.for("administer");
    const link =
      input.purpose === "manage" ? await console.openBillingPortal(actorRef(actor)) : await console.startCheckout(actorRef(actor));
    if (!link.ok) {
      if (link.code === "billing_disabled") throw new ToolError(BILLING_DISABLED);
      if (link.code === "no_billing_account") {
        throw new ToolError(
          'This workspace has never subscribed, so it has no billing portal yet. Call billing_checkout_link with purpose: "subscribe" to start a subscription.',
        );
      }
      throw new ToolError(refusal(link.code));
    }
    return {
      kind: link.kind,
      url: link.url,
      detail:
        link.kind === "checkout"
          ? "Give this checkout link to the person; they open it in a browser and pay by card. Then call billing_get to confirm numbers can be added."
          : "The workspace already has a billing account, so this is its billing portal. Give the link to the person; they open it in a browser to manage the subscription, card and invoices.",
      nextTool: link.kind === "checkout" ? "billing_get" : null,
    };
  },
});
