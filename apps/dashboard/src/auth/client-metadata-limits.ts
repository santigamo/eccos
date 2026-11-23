/**
 * Limits on the client metadata the console stores in an `oauthClient` row,
 * whichever way it arrives: a dynamic registration body
 * (server/oauth-request-limits.ts) or a fetched Client ID Metadata Document
 * (`cimdFetch` in oauth-provider.ts). Real metadata is well under 2 KiB.
 */

import { z } from "zod";

export const CLIENT_METADATA_MAX_BYTES = 8 * 1024;

const uri = z.string().max(512);
const uris = z.array(uri).max(5);

/** Every `oauthClient` column filled from free text or a URL. */
const clientMetadata = z.looseObject({
  client_name: z.string().max(100).optional(),
  redirect_uris: uris.optional(),
  post_logout_redirect_uris: uris.optional(),
  client_uri: uri.optional(),
  logo_uri: uri.optional(),
  policy_uri: uri.optional(),
  tos_uri: uri.optional(),
  jwks_uri: uri.optional(),
  backchannel_logout_uri: uri.optional(),
  contacts: z.array(z.string().max(254)).max(5).optional(),
  software_id: z.string().max(128).optional(),
  software_version: z.string().max(128).optional(),
  software_statement: z.string().max(2048).optional(),
  jwks: z.unknown().refine((value) => JSON.stringify(value).length <= 2048, "jwks is too large").optional(),
  metadata: z.unknown().refine((value) => JSON.stringify(value).length <= 1024, "metadata is too large").optional(),
});

const REDIRECT_URI_FIELDS = new Set<PropertyKey>(["redirect_uris", "post_logout_redirect_uris"]);

/** Why the metadata is refused, as an RFC 7591 §3.2.2 error, or undefined when it is within the limits. */
export function clientMetadataRefusal(
  metadata: unknown,
): { error: "invalid_client_metadata" | "invalid_redirect_uri"; description: string } | undefined {
  const result = clientMetadata.safeParse(metadata);
  if (result.success) return undefined;
  const [issue] = result.error.issues;
  const path = issue?.path ?? [];
  return {
    error: REDIRECT_URI_FIELDS.has(path[0] ?? "") ? "invalid_redirect_uri" : "invalid_client_metadata",
    description: `${path.join(".")}: ${issue?.message ?? "invalid"}`,
  };
}
