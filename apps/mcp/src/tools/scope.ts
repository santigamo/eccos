import type { AgentAction } from "@eccos/console-contract";
import type { AccountWabaResource, GatewayApi } from "@eccos/gateway-contract";
import {
  type ScopeMode,
  selectWaba,
} from "@eccos/gateway-contract/select-waba";
import { SCOPE_OF } from "../permissions";
import { ToolError, type ToolDeps } from "./registry";

/** The tools a result can send the agent to, with the action each needs (design § 4). */
const TOOL_ACTION = {
  connect_link_create: "administer",
  numbers_list: "view",
  number_recheck: "configure",
  templates_list: "view",
  template_send_test: "send",
} as const satisfies Record<string, AgentAction>;

/** Says `sentence`, which sends the agent to `tool`, only when this connection may call it. */
export type Point = (
  tool: keyof typeof TOOL_ACTION,
  sentence: string,
) => string;

export const pointer =
  (deps: Pick<ToolDeps, "can">): Point =>
  (tool, sentence) =>
    deps.can(TOOL_ACTION[tool])
      ? sentence
      : `This connection cannot call ${tool} (it needs the ${SCOPE_OF[TOOL_ACTION[tool]]} scope); the person can check this in the Eccos console.`;

const list = (ids: string[]) => ids.map((id) => `"${id}"`).join(", ");

/**
 * The WABA a tool runs against, chosen as the console chooses it (`selectWaba` with unknown ids
 * refused). The default applies only when the account has exactly one WABA, or when the one phone
 * the caller named belongs to exactly one; anything else is refused with the ids to pick from.
 * `mode: "active"` is the data-plane rule (sends); `"any"` is for WABA-level work (templates).
 */
export async function resolveWaba(
  gateway: GatewayApi,
  point: Point,
  accountId: string,
  {
    wabaId,
    phoneNumberId,
    mode,
  }: { wabaId?: string; phoneNumberId?: string; mode: ScopeMode },
): Promise<AccountWabaResource> {
  const { wabas } = await gateway.listAccountResources(accountId);
  const ids = wabas.map((waba) => waba.wabaId).sort();
  if (wabas.length === 0) {
    throw new ToolError(
      `This workspace has no WhatsApp Business account connected yet. ${point("connect_link_create", "Call connect_link_create and give the person the link, then call connect_status until it reports connected.")}`,
    );
  }
  if (wabaId !== undefined && !ids.includes(wabaId)) {
    throw new ToolError(
      `WABA "${wabaId}" is not connected to this workspace. Use one of: ${list(ids)}. ${point("numbers_list", "Call numbers_list to see them with their phones.")}`,
    );
  }
  const byPhone =
    phoneNumberId === undefined
      ? []
      : wabas.filter((waba) =>
          waba.phones.some((phone) => phone.phoneNumberId === phoneNumberId),
        );
  if (
    wabaId === undefined &&
    phoneNumberId !== undefined &&
    byPhone.length === 0
  ) {
    throw new ToolError(
      `Phone number id "${phoneNumberId}" is not registered in this workspace. ${point("numbers_list", "Call numbers_list to see every phone with its WABA.")}`,
    );
  }
  const requested =
    wabaId ??
    (wabas.length === 1
      ? wabas[0]?.wabaId
      : byPhone.length === 1
        ? byPhone[0]?.wabaId
        : undefined);
  if (requested === undefined) {
    throw new ToolError(
      `This workspace has ${wabas.length} WhatsApp Business accounts, so pass wabaId: one of ${list(ids)}. ${point("numbers_list", "Call numbers_list to see which phones each one has.")}`,
    );
  }
  const waba = selectWaba(accountId, wabas, requested, true, "any");
  if (mode === "active" && waba.status !== "active") {
    throw new ToolError(
      waba.status === "failed"
        ? `WABA "${waba.wabaId}" failed provisioning${waba.provisioningError ? ` (${waba.provisioningError})` : ""}, so nothing can be sent from it. ${point("number_recheck", "Call number_recheck with this wabaId to retry, then numbers_list to see the result.")}`
        : `WABA "${waba.wabaId}" is still being set up, so nothing can be sent from it yet. ${point("numbers_list", "Call numbers_list to follow its provisioning, or number_recheck if it stays pending.")}`,
    );
  }
  return waba;
}

/** The phone a send leaves from: the one named, or the WABA's only phone. */
export function resolvePhone(
  waba: AccountWabaResource,
  point: Point,
  phoneNumberId?: string,
): string {
  const ids = waba.phones.map((phone) => phone.phoneNumberId).sort();
  if (phoneNumberId !== undefined) {
    if (ids.includes(phoneNumberId)) return phoneNumberId;
    throw new ToolError(
      `Phone number id "${phoneNumberId}" is not registered on WABA "${waba.wabaId}". ${ids.length > 0 ? `Use one of: ${list(ids)}. ` : ""}${point("numbers_list", "Call numbers_list to see every phone with its WABA.")}`,
    );
  }
  if (ids.length === 1 && ids[0] !== undefined) return ids[0];
  if (ids.length === 0) {
    throw new ToolError(
      `WABA "${waba.wabaId}" has no phone number registered yet. ${point("numbers_list", "Call numbers_list to follow its provisioning.")}`,
    );
  }
  throw new ToolError(
    `WABA "${waba.wabaId}" has ${ids.length} phone numbers, so pass phoneNumberId: one of ${list(ids)}.`,
  );
}
