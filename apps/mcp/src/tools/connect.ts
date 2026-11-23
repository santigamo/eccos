import type { ConnectLinkSummary } from "@eccos/gateway-contract";
import { z } from "zod";
import { offer } from "./next";
import { type McpActor, type ToolDeps, defineTool } from "./registry";
import { isoTime } from "./scope";

/** The console's public connection page (apps/dashboard lib/connect-link/api.ts). */
const CONNECT_LINK_PATH = "/connect";

const linkState = z.enum(["pending", "opened", "connected", "unconfirmed", "expired"]);

/** Where a link stands and what the agent does next; the console's `linkStatusLine`, for an agent. */
function linkGuidance(link: ConnectLinkSummary, actor: McpActor, deps: ToolDeps): { detail: string; nextTool: string | null } {
  switch (link.state) {
    case "pending":
      return offer(deps, actor, `The link has not been opened yet. It works until ${isoTime(link.expiresAt)}.`, {
        tool: "connect_status",
        call: "Make sure the person has it, then call connect_status again later.",
      });
    case "opened":
      return offer(deps, actor, "The person opened the link and has not finished connecting a number.", {
        tool: "connect_status",
        call: "Call connect_status again in a minute or two.",
      });
    case "connected":
      return offer(deps, actor, link.connectedPhone ? `The link connected ${link.connectedPhone}.` : "The link connected a WhatsApp Business account.", {
        tool: "numbers_list",
        call: "Call numbers_list to follow its setup.",
      });
    case "unconfirmed":
      return offer(deps, actor, "The link was used, but the result was not confirmed: something may already be connected.", {
        tool: "numbers_list",
        call: "Call numbers_list before making a new link.",
      });
    case "expired":
      return offer(deps, actor, "The link expired unused.", { tool: "connect_link_create", call: "Call connect_link_create to make a new one." });
  }
}

const linkView = (link: ConnectLinkSummary, actor: McpActor, deps: ToolDeps) => ({
  state: link.state,
  expiresAt: isoTime(link.expiresAt),
  connectedPhone: link.connectedPhone,
  createdByYou: link.creatorUserId === actor.userId,
  ...linkGuidance(link, actor, deps),
});

export const connectStatus = defineTool({
  name: "connect_status",
  action: "administer",
  reads: [],
  stepUp: false,
  title: "Get the connection link's status",
  description: [
    "Reports where this workspace's connection link stands: none (never made), pending (not opened yet), opened (a person is connecting a number),",
    "connected (with the number it connected), unconfirmed (used, result not confirmed) or expired. createdByYou says whether the person this agent acts for made it.",
    "Use it after connect_link_create to follow the person's progress; nextTool names what to call next. It changes nothing and never returns the link itself.",
  ].join(" "),
  inputSchema: z.object({}),
  outputSchema: z.object({
    state: z.enum(["none", ...linkState.options]),
    expiresAt: z.string().nullable(),
    connectedPhone: z.string().nullable(),
    createdByYou: z.boolean().nullable(),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_input, actor, deps) => {
    const { gateway } = deps.for("administer");
    const link = await gateway.getConnectLink(actor.accountId);
    if (!link) {
      return {
        state: "none" as const,
        expiresAt: null,
        connectedPhone: null,
        createdByYou: null,
        ...offer(deps, actor, "No connection link was ever made for this workspace.", {
          tool: "connect_link_create",
          call: "Call connect_link_create to make one.",
        }),
      };
    }
    return linkView(link, actor, deps);
  },
});

export const connectLinkCreate = defineTool({
  name: "connect_link_create",
  action: "administer",
  reads: [],
  stepUp: true,
  title: "Create the link to connect a WhatsApp number",
  description: [
    "Makes this workspace's connection link: a single-use URL, valid for 7 days, that a person opens in a browser to connect a WhatsApp number",
    "through Meta's Embedded Signup. You cannot complete it yourself: give the url to the person who manages the business's WhatsApp, and treat it",
    "like a password, since whoever opens it can add a number to this workspace. The url is returned only by the call that makes it.",
    "When a link already exists and replace is false, nothing new is made and status is exists, with no url. Pass replace: true to make a new link",
    "and stop the old one, for example when the person lost it or it was already used. Then follow progress with connect_status.",
  ].join(" "),
  inputSchema: z.object({
    replace: z
      .boolean()
      .default(false)
      .describe("Make a new link even if one exists, and stop the old one. Default false: keep a link that exists."),
  }),
  outputSchema: z.object({
    status: z.enum(["created", "exists"]),
    url: z.string().nullable().describe("The link for a person to open. Only set when status is created."),
    state: linkState,
    expiresAt: z.string().nullable(),
    connectedPhone: z.string().nullable(),
    createdByYou: z.boolean(),
    detail: z.string(),
    nextTool: z.string().nullable(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  audit: (input) => ({ replace: String(input.replace) }),
  // The console's openConnectLink (apps/dashboard src/server/gateway.ts): keep a link that has
  // not expired unless asked to replace it, and let the gateway keep a live one on a race.
  run: async (input, actor, deps, trail) => {
    const { gateway } = deps.for("administer");
    const exists = (link: ConnectLinkSummary) => {
      trail.detail("exists");
      return {
        status: "exists" as const,
        url: null,
        ...linkView(link, actor, deps),
        detail: `A connection link already exists (${link.state}); its URL was shown only to whoever made it. ${linkGuidance(link, actor, deps).detail} If the person does not have the link, call connect_link_create with replace: true.`,
      };
    };
    const current = input.replace ? null : await gateway.getConnectLink(actor.accountId);
    if (current && current.state !== "expired") return exists(current);
    const issued = await gateway.issueConnectLink(actor.accountId, actor.userId, input.replace);
    if (issued === "exists") {
      const link = await gateway.getConnectLink(actor.accountId);
      if (!link) throw new Error("the connection link could not be read");
      return exists(link);
    }
    trail.detail(input.replace ? "replaced" : "created");
    return {
      status: "created" as const,
      // In the fragment, so the token reaches no server log and no Referer.
      url: `${deps.consoleOrigin}${CONNECT_LINK_PATH}#${issued.token}`,
      state: "pending" as const,
      expiresAt: isoTime(issued.expiresAt),
      connectedPhone: null,
      createdByYou: true,
      ...offer(
        deps,
        actor,
        `Give this link to the person who manages the business's WhatsApp; they open it in a browser and follow Meta's steps. It works once, until ${isoTime(issued.expiresAt)}.`,
        { tool: "connect_status", call: "Then call connect_status to follow their progress." },
      ),
    };
  },
});
