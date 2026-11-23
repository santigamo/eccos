/**
 * What the consent page of an agent's authorization shows (task 1.3, design
 * §3.4): the client's registered name and the workspace the consent would
 * bind. Display only: Better Auth binds the session's active workspace, and
 * only while the user is a member of it (`consentReferenceId` in
 * `auth/oauth-provider.ts`), so this reads the same thing the same way.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuthForRequest } from "./auth/request-auth";
import { requireAuthContext } from "./auth/server-auth";
import { resolveMemberships, type Membership } from "./auth/tenant";

export interface OAuthConsentDetails {
  /** Null when the client is unknown or disabled: the request cannot be answered. */
  clientName: string | null;
  /** Null when the session has no workspace it belongs to: the workspace step comes first. */
  workspace: Membership | null;
}

const consentInput = z.object({ clientId: z.string().trim().min(1).max(512) }).strict();

export const getOAuthConsent = createServerFn({ method: "GET" })
  .validator((input: unknown) => consentInput.parse(input))
  .handler(async ({ data }): Promise<OAuthConsentDetails> => {
    const request = getRequest();
    const auth = getAuthForRequest(request, env);
    const { session } = await requireAuthContext(auth, request);
    const client = (await auth.api
      .getOAuthClientPublic({ query: { client_id: data.clientId }, headers: request.headers })
      .catch(() => null)) as { client_name?: string } | null;
    const workspaces = await resolveMemberships(auth, request.headers);
    return {
      clientName: client ? client.client_name || data.clientId : null,
      workspace: workspaces.find((workspace) => workspace.id === session.activeOrganizationId) ?? null,
    };
  });
