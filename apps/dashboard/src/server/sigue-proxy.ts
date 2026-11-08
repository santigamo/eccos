/**
 * Visitor IP behind the Sigue Online fallback proxy.
 *
 * During a block window, app.eccos.chat resolves to a Caddy proxy with a dedicated
 * IP that forwards to the Cloudflare edge. Cloudflare then sets `cf-connecting-ip`
 * to the proxy for EVERY visitor, so all of them would share the auth rate-limit
 * buckets keyed on that header (10 sign-ins per 5 min for the whole console).
 *
 * Caddy adds the visitor IP and a shared secret. They are trusted only when the
 * request really arrives from a configured proxy IP AND the secret matches; then
 * `cf-connecting-ip` is rewritten here, once, so every downstream reader keeps
 * working unchanged. In every other case the `x-sigue-*` headers are stripped and
 * the request passes through as it came. Both env values unset = feature off.
 */

export const SIGUE_CLIENT_IP_HEADER = "x-sigue-client-ip";
export const SIGUE_PROXY_AUTH_HEADER = "x-sigue-proxy-auth";

export interface SigueProxyEnv {
  /** Comma-separated egress IPs of the fallback proxy (var). Empty = off. */
  SIGUE_PROXY_IPS?: string;
  /** Shared secret the proxy sends in `x-sigue-proxy-auth` (secret). Unset = off. */
  SIGUE_PROXY_SECRET?: string;
}

/** Returns the request with the trusted visitor IP applied and the `x-sigue-*` headers removed. */
export function withSigueClientIp(request: Request, env: SigueProxyEnv): Request {
  if (!request.headers.has(SIGUE_CLIENT_IP_HEADER) && !request.headers.has(SIGUE_PROXY_AUTH_HEADER)) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete(SIGUE_CLIENT_IP_HEADER);
  headers.delete(SIGUE_PROXY_AUTH_HEADER);
  const visitorIp = trustedClientIp(request.headers, env);
  if (visitorIp) headers.set("cf-connecting-ip", visitorIp);
  return new Request(request, { headers });
}

/** The visitor IP claimed by the proxy, or null if the claim must not be trusted. */
export function trustedClientIp(headers: Headers, env: SigueProxyEnv): string | null {
  const secret = env.SIGUE_PROXY_SECRET?.trim() ?? "";
  const proxyIps = parseIpList(env.SIGUE_PROXY_IPS);
  if (secret.length === 0 || proxyIps.size === 0) return null;

  const peer = headers.get("cf-connecting-ip")?.trim().toLowerCase();
  if (!peer || !proxyIps.has(peer)) return null;
  if (!constantTimeEqual(headers.get(SIGUE_PROXY_AUTH_HEADER) ?? "", secret)) return null;

  const claimed = headers.get(SIGUE_CLIENT_IP_HEADER)?.trim() ?? "";
  return isIpAddress(claimed) ? claimed : null;
}

function parseIpList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((ip) => ip.trim().toLowerCase())
      .filter((ip) => ip.length > 0),
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Shape check only: enough to refuse header garbage, not a full RFC parser. */
export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true;
  return value.length <= 45 && value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value);
}
