import type { CreateBroadcastFailureCode } from "@eccos/gateway-contract";
import { fmtCount } from "../ui";

/** The console's own refusal: a workspace in its unpaid setup window starts no broadcast from here. */
export type ConsoleBroadcastFailureCode = CreateBroadcastFailureCode | "setup_window";

export type BroadcastAction = "edit" | "retry" | "template" | "broadcasts" | "reload";

export interface BroadcastFailureCopy {
  title: string;
  /** The gateway's own words, shown in mono beneath, when they help. */
  detail: string | null;
  actions: BroadcastAction[];
}

/** Every refusal said in the operator's terms, and what they can do next (the API's answer never drives UI). */
export function broadcastFailureCopy(
  failure: { code: ConsoleBroadcastFailureCode; detail: string | null; invalid?: unknown[]; templateStatus?: string },
  context: { template: string; sender: string },
): BroadcastFailureCopy {
  const nothing = "Nothing was sent.";
  switch (failure.code) {
    case "invalid_recipients":
      return {
        title: `Eccos refused ${fmtCount(failure.invalid?.length ?? 0)} rows of this list. ${nothing}`,
        detail: null,
        actions: ["edit"],
      };
    case "invalid_request":
      return { title: `The broadcast could not be built. ${nothing}`, detail: failure.detail, actions: ["edit"] };
    case "subscription_required":
      return { title: `Sending is paused for this workspace. ${nothing}`, detail: null, actions: [] };
    case "setup_window":
      return {
        title: `Broadcasts start from the console once this workspace is subscribed. ${nothing}`,
        detail: null,
        actions: [],
      };
    case "no_phone":
      return { title: `${context.sender} is no longer connected to this account. ${nothing}`, detail: null, actions: ["edit"] };
    case "too_many_running":
      return {
        title: "Five broadcasts are already running on this account. Wait for one to finish, or cancel one. Your list is still here.",
        detail: null,
        actions: ["broadcasts", "retry"],
      };
    case "too_large":
      return { title: "This list is too large to send as one broadcast. Split it into two.", detail: null, actions: ["edit"] };
    case "template_not_approved":
      return {
        title: `${context.template} is no longer approved: Meta now lists it as ${failure.templateStatus ?? "not approved"}. ${nothing}`,
        detail: null,
        actions: ["template", "edit"],
      };
    case "template_not_found":
      return { title: `${context.template} no longer exists at Meta. ${nothing}`, detail: null, actions: ["template", "edit"] };
    case "template_unsupported":
      return { title: `${context.template} has parts the console cannot send. ${nothing}`, detail: failure.detail, actions: ["edit"] };
    case "parameter_mismatch":
      return {
        title: `This template's variables changed since you opened this page. ${nothing}`,
        detail: null,
        actions: ["reload"],
      };
    case "key_reused":
      return { title: "Something changed in this broadcast. Review it again.", detail: null, actions: [] };
    case "templates_unreachable":
      return { title: `Eccos could not check the template with Meta. ${nothing}`, detail: null, actions: ["retry"] };
  }
}

/** No answer at all: the key is kept, so trying again cannot start a second broadcast. */
export const NO_ANSWER: BroadcastFailureCopy = {
  title: "No answer from Eccos. Trying again is safe: it will not start a second broadcast.",
  detail: null,
  actions: ["retry"],
};
