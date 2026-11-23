// Refresh-token rotation replay: T0 -> T1, replay T0 inside @better-auth/mcp's 30 s reuse window,
// use T1 -> T2, then replay T0 again after the window and check that the whole family dies.
import { $ } from "bun";
import { CONSOLE, RESOURCE, save } from "./lib";

const s = await Bun.file(new URL("../evidence/.session.json", import.meta.url).pathname).json();
const d1 = async (sql: string) => JSON.parse(await $`cd ../dashboard && bunx wrangler d1 execute eccos-auth --local --json --command ${sql}`.quiet().text())[0].results;
const refresh = async (token: string) => {
  const r = await fetch(CONSOLE + "/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: s.client.client_id, resource: RESOURCE }),
  });
  const body = (await r.json()) as Record<string, string>;
  return { status: r.status, error: body.error, refreshPrefix: body.refresh_token?.slice(0, 6), token: body.refresh_token };
};
const rows = () => d1(`SELECT id, revoked IS NOT NULL AS revoked, rotatedAt IS NOT NULL AS rotated, typeof(revoked) AS revokedType, createdAt FROM oauthRefreshToken WHERE clientId = '${s.client.client_id}' ORDER BY createdAt`);
const out: Record<string, unknown> = { t0Prefix: s.tokens.refresh_token.slice(0, 6), rowsBefore: await rows() };
const r1 = await fetch(CONSOLE + "/api/auth/oauth2/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.tokens.refresh_token, client_id: s.client.client_id, resource: RESOURCE }),
});
const b1 = (await r1.json()) as Record<string, string>;
out.rotate_t0 = { status: r1.status, t1Prefix: b1.refresh_token?.slice(0, 6) };
out.rowsAfterRotate = await rows();
out.replay_t0 = { ...(await refresh(s.tokens.refresh_token)), token: undefined };
out.rowsAfterReplay = await rows();
const t2 = await refresh(b1.refresh_token);
out.use_t1_after_replay = { ...t2, token: undefined };
await Bun.sleep(32_000);
out.replay_t0_after_window = { ...(await refresh(s.tokens.refresh_token)), token: undefined };
out.use_t2_after_late_replay = { ...(await refresh(t2.token)), token: undefined };
out.rowsEnd = await rows();
save("12-refresh-replay.json", out);
console.log(JSON.stringify(out, null, 1));
