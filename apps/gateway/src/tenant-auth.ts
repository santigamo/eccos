import { constantTimeEqual } from "@eccos/core/signature";
import { getConfig } from "./config";
import { getControlPlaneStub } from "./control-plane-stub";
import { isTenantControlPlaneEnabled } from "./tenant-config";

export interface RequestAccount {
  accountId: string;
  keyId: string | null;
}

export function extractApiKey(
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
): string | undefined {
  if (authorizationHeader?.startsWith("Bearer ")) return authorizationHeader.slice(7);
  return apiKeyHeader;
}

export async function authenticateRequest(
  env: Env,
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
): Promise<RequestAccount | null> {
  const key = extractApiKey(authorizationHeader, apiKeyHeader);
  if (!key) return null;
  if (isTenantControlPlaneEnabled(env)) {
    return getControlPlaneStub(env).authenticateApiKey(key);
  }
  return authenticateLegacyRequest(env, authorizationHeader, apiKeyHeader);
}

export function authenticateLegacyRequest(
  env: Env,
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
): RequestAccount | null {
  const key = extractApiKey(authorizationHeader, apiKeyHeader);
  if (!key) return null;
  const config = getConfig(env);
  return constantTimeEqual(key, config.ECCOS_API_KEY) ? { accountId: "__legacy__", keyId: null } : null;
}
