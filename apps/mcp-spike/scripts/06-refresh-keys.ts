// Refresh and revocation semantics; JWT key storage on D1.
import { $ } from "bun";
import { CONSOLE, RESOURCE, decodeJwt, save } from "./lib";

const s = await Bun.file(new URL("../evidence/.session.json", import.meta.url).pathname).json();
const d1 = async (sql: string) => JSON.parse(await $`cd ../dashboard && bunx wrangler d1 execute eccos-auth --local --json --command ${sql}`.quiet().text())[0].results;
const refresh = async (token: string) => {
  const r = await fetch(CONSOLE + "/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: s.client.client_id, resource: RESOURCE }),
  });
  const body = (await r.json()) as Record<string, string>;
  return { status: r.status, body, claims: body.access_token ? decodeJwt(body.access_token).payload : null };
};
const out: Record<string, unknown> = {};
out.jwks_rows = await d1("SELECT id, alg, crv, createdAt, expiresAt, length(privateKey) AS privateKeyLength, substr(privateKey, 1, 12) AS privateKeyPrefix FROM jwks");
out.jwks_endpoint = await (await fetch(CONSOLE + "/api/auth/jwks")).json();
out.consent_rows_for_client = await d1(`SELECT count(*) AS n FROM oauthConsent WHERE clientId = '${s.client.client_id}'`);
// 02-mcp.ts step F deleted the consent row. Does the refresh token still work?
const r1 = await refresh(s.tokens.refresh_token);
out.refresh_after_consent_row_deleted = { status: r1.status, error: r1.body.error, workspaceClaim: r1.claims?.["https://eccos.chat/workspace"] };
// Remove the membership: refresh must be refused by customAccessTokenClaims.
if (r1.body.refresh_token) {
  const sub = r1.claims!.sub as string;
  const [m] = await d1(`SELECT * FROM member WHERE userId = '${sub}' AND organizationId = '${s.second}'`);
  await d1(`DELETE FROM member WHERE id = '${m.id}'`);
  const r2 = await refresh(r1.body.refresh_token);
  out.refresh_after_membership_removed = { status: r2.status, body: r2.body };
  await d1(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('${m.id}', '${m.organizationId}', '${m.userId}', '${m.role}', '${m.createdAt}')`);
  // Replay of a rotated refresh token.
  const r3 = await refresh(s.tokens.refresh_token);
  out.replay_rotated_refresh = { status: r3.status, body: r3.body };
}
out.refresh_rows = await d1(`SELECT revoked IS NOT NULL AS revoked, referenceId, rotatedAt IS NOT NULL AS rotated FROM oauthRefreshToken WHERE clientId = '${s.client.client_id}'`);
save("06-refresh-keys.json", out);
console.log(JSON.stringify(out, null, 1).slice(0, 5000));
