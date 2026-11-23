// Bullet: step-up inside the consent visit: re-authentication and TOTP without losing the signed
// authorization query.
import { createHmac } from "node:crypto";
import { $ } from "bun";
import { Browser, CONSOLE, PASSWORD, RESOURCE, newUser, pkce, save } from "./lib";

function totp(secretB32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretB32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}

const out: Record<string, unknown> = {};
// Each code is used once: wait for the next 30-second window before every verification.
const nextWindow = () => new Promise((r) => setTimeout(r, 30_500 - (Date.now() % 30_000)));
const REDIRECT = "http://127.0.0.1:53682/callback";
const { client_id } = (await (await fetch(CONSOLE + "/api/auth/oauth2/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Spike Step-up Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
})).json()) as { client_id: string };

// An admin with TOTP enrolled.
const { b: setup, email } = await newUser("stepup", "Step-up Workspace");
const enable = (await (await setup.post("/api/auth/two-factor/enable", { password: PASSWORD })).json()) as { totpURI: string };
const secret = new URL(enable.totpURI).searchParams.get("secret")!;
const enrolled = await setup.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
out.enrollment = { verifyStatus: enrolled.status };

const authorize = () => {
  const u = new URL(CONSOLE + "/api/auth/oauth2/authorize");
  u.search = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s", resource: RESOURCE, scope: "eccos:view eccos:administer offline_access" }).toString();
  return u.href;
};
const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t.slice(0, 200); } };

// A. Signed out: sign-in (password) -> TOTP -> does the flow continue to the workspace step?
{
  const b = new Browser();
  const first = await b.follow(authorize(), (u) => u.pathname !== "/api/auth/oauth2/authorize");
  const q = new URL(first.url).search.slice(1);
  const signIn = await b.post("/api/auth/sign-in/email", { email, password: PASSWORD, oauth_query: q });
  const signInBody = await json(signIn);
  await nextWindow();
  const verifyWithQuery = await b.post("/api/auth/two-factor/verify-totp", { code: totp(secret), oauth_query: q });
  out.A_signin_then_totp = { loginPage: new URL(first.url).pathname, signIn: { status: signIn.status, body: signInBody }, verifyTotp: { status: verifyWithQuery.status, body: await json(verifyWithQuery) } };
}

// B. Signed in, in the consent visit, the page demands a fresh sign-in (session older than 15 min).
//    Age the session in D1, then re-authenticate with the consent page's signed query.
{
  const b = new Browser();
  const first = await b.follow(authorize(), (u) => u.pathname !== "/api/auth/oauth2/authorize");
  const q1 = new URL(first.url).search.slice(1);
  await b.post("/api/auth/sign-in/email", { email, password: PASSWORD, oauth_query: q1 });
  await nextWindow();
  const v = await json(await b.post("/api/auth/two-factor/verify-totp", { code: totp(secret), oauth_query: q1 }));
  // Reach the consent page.
  let at = new URL(v.url ?? v.redirect_uri ?? "/", CONSOLE);
  if (at.pathname === "/spike/workspace") {
    const orgs = await json(await b.fetch(CONSOLE + "/api/auth/organization/list", { headers: { accept: "application/json" } }));
    await b.post("/api/auth/organization/set-active", { organizationId: orgs[0].id });
    const c = await json(await b.post("/api/auth/oauth2/continue", { postLogin: true, oauth_query: at.search.slice(1) }));
    at = new URL(c.url, CONSOLE);
  }
  const consentQuery = at.search.slice(1);
  const token = decodeURIComponent(b.jar.get("better-auth.session_token") ?? "").split(".")[0];
  await $`cd ../dashboard && bunx wrangler d1 execute eccos-auth --local --command "UPDATE session SET createdAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'), updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') WHERE token = '${token}'"`.quiet();
  const session = await json(await b.fetch(CONSOLE + "/api/auth/get-session", { headers: { accept: "application/json" } }));
  // Re-authentication carrying the consent page's signed query.
  const reauth = await b.post("/api/auth/sign-in/email", { email, password: PASSWORD, oauth_query: consentQuery });
  const reauthBody = await json(reauth);
  await nextWindow();
  const totpAgain = await b.post("/api/auth/two-factor/verify-totp", { code: totp(secret), oauth_query: consentQuery });
  const totpAgainBody = await json(totpAgain);
  const landed = totpAgainBody?.url ? new URL(totpAgainBody.url, CONSOLE) : null;
  // Then accept consent with the query the person came back with.
  const sessionAfter = await json(await b.fetch(CONSOLE + "/api/auth/get-session", { headers: { accept: "application/json" } }));
  const consentAfter = landed ? await b.post("/api/auth/oauth2/consent", { accept: true, oauth_query: landed.search.slice(1) }) : null;
  out.B_reauth_in_consent = {
    consentPage: at.pathname,
    agedSessionCreatedAt: session?.session?.createdAt,
    reauth: { status: reauth.status, body: reauthBody },
    totp: { status: totpAgain.status, body: totpAgainBody, landedOn: landed?.pathname },
    freshSessionCreatedAt: sessionAfter?.session?.createdAt,
    consentAccepted: consentAfter && { status: consentAfter.status, body: await json(consentAfter) },
  };
}
save("05-stepup.json", out);
console.log(JSON.stringify(out, null, 1).replace(/(code=)[^&"]+/g, "$1…").slice(0, 6000));
