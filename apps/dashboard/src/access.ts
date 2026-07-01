import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Cloudflare Access JWT verification — defense-in-depth for the operator console.
 *
 * When the dashboard is deployed behind a Cloudflare Access application, Access
 * injects a signed `Cf-Access-Jwt-Assertion` JWT on every allowed request. This
 * Worker-side gate re-verifies that JWT so the app cannot be reached by hitting
 * the raw `workers.dev` origin directly (which would bypass the Access edge). It
 * is intentionally a no-op until configured, so local `vite dev` and a fresh
 * deploy without Access still work.
 */

/**
 * Minimal, decoupled view of the Worker `env` the gate reads. Both are optional
 * and empty by default; keeping this local (instead of `Cloudflare.Env`) makes
 * `enforceAccess` trivially unit-testable and independent of how `wrangler types`
 * happens to type the (empty-string default) vars.
 */
export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const JWT_HEADER = "Cf-Access-Jwt-Assertion";
const COOKIE_NAME = "CF_Authorization";

/**
 * Cache one remote JWKS per team domain at module scope. `createRemoteJWKSet`
 * returns a key-getter that owns its own fetch + in-memory cache/cooldown, so it
 * must be created once and reused — not rebuilt per request.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Normalize the configured team domain so `myteam.cloudflareaccess.com`,
 * `https://myteam.cloudflareaccess.com` and a trailing-slash variant all yield
 * the same host used for the JWKS URL and the `iss` claim.
 */
function normalizeTeamDomain(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** Read the Access JWT from the header, falling back to the `CF_Authorization` cookie. */
function readToken(request: Request): string | null {
  const header = request.headers.get(JWT_HEADER);
  if (header) return header;

  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

const forbidden = (): Response => new Response("Forbidden", { status: 403 });

/**
 * Verify the Cloudflare Access JWT for an incoming request.
 *
 * Returns a `403` {@link Response} to BLOCK the request, or `null` to ALLOW it
 * through to the app.
 *
 * The gate only enforces when BOTH `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are
 * non-empty. Otherwise it is a pass-through no-op — so local dev and any deploy
 * that hasn't been placed behind Access keep working. When enforcing, a missing
 * token or any verification failure fails closed (403); jose checks the RS256
 * signature (via the team's JWKS) plus the `iss`, `aud`, and `exp`/`nbf` claims.
 */
export async function enforceAccess(
  request: Request,
  env: AccessEnv,
): Promise<Response | null> {
  const teamDomainRaw = env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.ACCESS_AUD?.trim();

  // Not configured → no gate (local dev / fresh deploy without Access).
  if (!teamDomainRaw || !audience) return null;

  const teamDomain = normalizeTeamDomain(teamDomainRaw);
  if (!teamDomain) return null;

  const token = readToken(request);
  if (!token) return forbidden();

  try {
    await jwtVerify(token, getJwks(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience,
      algorithms: ["RS256"],
    });
    return null; // Valid Access JWT → allow.
  } catch {
    return forbidden(); // Invalid / expired / wrong aud|iss → fail closed.
  }
}
