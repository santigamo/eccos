import { getControlPlaneStub } from "./control-plane-stub";

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

/** Resolves a hashed, revocable account API key from the control plane. */
export async function authenticateRequest(
  env: Env,
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
): Promise<RequestAccount | null> {
  const key = extractApiKey(authorizationHeader, apiKeyHeader);
  if (!key) return null;
  const account = await getControlPlaneStub(env).authenticateApiKey(key);
  return account ? { accountId: account.accountId, keyId: account.keyId } : null;
}