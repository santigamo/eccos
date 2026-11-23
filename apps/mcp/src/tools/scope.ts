import type { AccountWabaResource } from "@eccos/gateway-contract";
import { selectWaba } from "@eccos/gateway-contract/select-waba";
import { z } from "zod";
import { offer } from "./next";
import { type McpActor, ToolError, type ToolDeps } from "./registry";

/** The optional WABA selector every per-WABA tool takes. Never an account or organization id. */
export const wabaIdInput = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional()
  .describe(
    "The WhatsApp Business account (WABA) id, as numbers_list returns it. Leave it out when the workspace has exactly one.",
  );

/** Epoch ms as an ISO time, keeping null. */
export const isoTime = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

const refusal =
  (deps: ToolDeps, actor: McpActor) =>
  (fact: string, next?: Parameters<typeof offer>[3]) =>
    new ToolError(offer(deps, actor, fact, next).detail);

/**
 * The WABA a call is about, from the actor's own account only. With no `wabaId` the workspace's
 * only WABA is used, or the one WABA that owns `phoneNumberId` when the caller named a phone;
 * otherwise, or with an id the account does not own, the agent is told which ids exist here.
 * `active` refuses a WABA still provisioning or failed (sends need one). Nothing about any other
 * account is ever looked up or named, and a tool is named only when this connection may call it.
 */
export async function ownedWaba(
  deps: ToolDeps,
  actor: McpActor,
  wabaId: string | undefined,
  {
    phoneNumberId,
    active = false,
  }: { phoneNumberId?: string; active?: boolean } = {},
): Promise<AccountWabaResource> {
  const refuse = refusal(deps, actor);
  const { wabas } = await deps
    .for("view")
    .gateway.listAccountResources(actor.accountId);
  if (wabas.length === 0) {
    throw refuse(
      "No WhatsApp Business account is connected to this workspace yet.",
      {
        tool: "connect_link_create",
        call: "Call connect_link_create and give the person the link.",
      },
    );
  }
  const ids = wabas.map((waba) => waba.wabaId).sort();
  if (wabaId !== undefined && !ids.includes(wabaId)) {
    throw refuse(
      `WABA ${wabaId} is not connected to this workspace. Its WABAs are: ${ids.join(", ")}.`,
      {
        tool: "numbers_list",
        call: "Call numbers_list to see them.",
      },
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
    throw refuse(
      `Phone number id ${phoneNumberId} is not registered in this workspace.`,
      {
        tool: "numbers_list",
        call: "Call numbers_list to see every phone with its WABA.",
      },
    );
  }
  const chosen =
    wabaId ??
    (ids.length === 1
      ? ids[0]
      : byPhone.length === 1
        ? byPhone[0]?.wabaId
        : undefined);
  if (chosen === undefined) {
    throw refuse(
      `This workspace has ${ids.length} WhatsApp Business accounts: ${ids.join(", ")}. Call again with wabaId set to one of them.`,
      {
        tool: "numbers_list",
        call: "Call numbers_list to see the numbers on each.",
      },
    );
  }
  const waba = selectWaba(actor.accountId, wabas, chosen, true, "any");
  if (active && waba.status === "failed") {
    throw refuse(
      `WABA ${waba.wabaId} failed provisioning${waba.provisioningError ? ` (${waba.provisioningError})` : ""}, so nothing can be sent from it.`,
      {
        tool: "number_recheck",
        call: "Call number_recheck with this wabaId to retry, then numbers_list to see the result.",
      },
    );
  }
  if (active && waba.status !== "active") {
    throw refuse(
      `WABA ${waba.wabaId} is still being set up, so nothing can be sent from it yet.`,
      {
        tool: "numbers_list",
        call: "Call numbers_list to follow its provisioning, or number_recheck if it stays pending.",
      },
    );
  }
  return waba;
}

/** The phone a send leaves from: the one named, or the WABA's only phone. */
export function ownedPhone(
  deps: ToolDeps,
  actor: McpActor,
  waba: AccountWabaResource,
  phoneNumberId: string | undefined,
): string {
  const refuse = refusal(deps, actor);
  const ids = waba.phones.map((phone) => phone.phoneNumberId).sort();
  if (phoneNumberId !== undefined) {
    if (ids.includes(phoneNumberId)) return phoneNumberId;
    throw refuse(
      `Phone number id ${phoneNumberId} is not registered on WABA ${waba.wabaId}.${ids.length > 0 ? ` Its phones are: ${ids.join(", ")}.` : ""}`,
      {
        tool: "numbers_list",
        call: "Call numbers_list to see every phone with its WABA.",
      },
    );
  }
  const [only] = ids;
  if (ids.length === 1 && only !== undefined) return only;
  if (ids.length === 0) {
    throw refuse(`WABA ${waba.wabaId} has no phone number registered yet.`, {
      tool: "numbers_list",
      call: "Call numbers_list to follow its provisioning.",
    });
  }
  throw refuse(
    `WABA ${waba.wabaId} has ${ids.length} phone numbers: ${ids.join(", ")}. Call again with phoneNumberId set to one of them.`,
  );
}
