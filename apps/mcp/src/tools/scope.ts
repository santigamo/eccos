import type { AccountWabaResource, GatewayApi } from "@eccos/gateway-contract";
import { selectWaba } from "@eccos/gateway-contract/select-waba";
import { z } from "zod";
import { offer } from "./next";
import { ToolError, type ToolDeps } from "./registry";

/** The optional WABA selector every per-WABA tool takes. Never an account or organization id. */
export const wabaIdInput = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional()
  .describe("The WhatsApp Business account (WABA) id, as numbers_list returns it. Leave it out when the workspace has exactly one.");

/** Epoch ms as an ISO time, keeping null. */
export const isoTime = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * The WABA a call is about, from the actor's own account only. With no `wabaId` the workspace's
 * only WABA is used; with several, or with an id the account does not own, the agent is told
 * which ids exist here. Nothing about any other account is ever looked up or named, and a tool
 * is named only when this connection may call it.
 */
export async function ownedWaba(
  deps: ToolDeps,
  gateway: GatewayApi,
  accountId: string,
  wabaId: string | undefined,
): Promise<AccountWabaResource> {
  const refuse = (fact: string, next: Parameters<typeof offer>[2]) => new ToolError(offer(deps, fact, next).detail);
  const { wabas } = await gateway.listAccountResources(accountId);
  if (wabas.length === 0) {
    throw refuse("No WhatsApp Business account is connected to this workspace yet.", {
      tool: "connect_link_create",
      call: "Call connect_link_create and give the person the link.",
    });
  }
  const ids = wabas.map((waba) => waba.wabaId).sort();
  if (wabaId === undefined && ids.length > 1) {
    throw refuse(
      `This workspace has ${ids.length} WhatsApp Business accounts: ${ids.join(", ")}. Call again with wabaId set to one of them.`,
      { tool: "numbers_list", call: "Call numbers_list to see the numbers on each." },
    );
  }
  if (wabaId !== undefined && !ids.includes(wabaId)) {
    throw refuse(`WABA ${wabaId} is not connected to this workspace. Its WABAs are: ${ids.join(", ")}.`, {
      tool: "numbers_list",
      call: "Call numbers_list to see them.",
    });
  }
  return selectWaba(accountId, wabas, wabaId ?? ids[0], true, "any");
}
