// Bullet: resuming an authorization after email verification (a brand-new customer).
import { Browser, CONSOLE, PASSWORD, RESOURCE, mailUrl, pkce, save, sleep } from "./lib";

const REDIRECT = "http://127.0.0.1:53682/callback";
const reg = await fetch(CONSOLE + "/api/auth/oauth2/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Spike Signup Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
});
const { client_id } = (await reg.json()) as { client_id: string };
const authorizeUrl = (prompt?: string) => {
  const u = new URL(CONSOLE + "/api/auth/oauth2/authorize");
  u.search = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s1", resource: RESOURCE, scope: "eccos:view offline_access", ...(prompt ? { prompt } : {}) }).toString();
  return u;
};
const out: Record<string, unknown> = {};

async function attempt(label: string, opts: { prompt?: string; callback: "oauth_query" | "authorize_url" }) {
  const b = new Browser();
  const start = authorizeUrl(opts.prompt);
  const first = await b.follow(start.href, (u) => u.pathname !== "/api/auth/oauth2/authorize");
  const loginPage = new URL(first.url);
  const email = `${label}-${Date.now()}@spike.test`.toLowerCase();
  const body: Record<string, unknown> = { email, password: PASSWORD, name: label };
  if (opts.callback === "oauth_query") {
    body.oauth_query = loginPage.search.slice(1);
    body.callbackURL = "/";
  } else {
    body.callbackURL = start.pathname + start.search;
  }
  const signUp = await b.post("/api/auth/sign-up/email", body);
  const signUpBody = await signUp.text();
  await sleep(500);
  let verify: string;
  try {
    verify = mailUrl(email);
  } catch {
    return { loginPage: loginPage.pathname, signUp: { status: signUp.status, body: signUpBody.slice(0, 300) }, noVerificationMail: true, trail: b.trail };
  }
  const verifyTarget = new URL(verify).searchParams.get("callbackURL");
  // The person clicks the link (a fresh browser tab shares the cookie jar).
  const landed = await b.follow(verify, (u) => u.pathname.startsWith("/spike/") || u.origin !== new URL(CONSOLE).origin);
  return {
    loginPage: loginPage.pathname, loginPageParams: [...loginPage.searchParams.keys()],
    signUp: { status: signUp.status, body: signUpBody.slice(0, 200) },
    verifyLinkCallbackURL: verifyTarget && verifyTarget.slice(0, 60) + (verifyTarget.length > 60 ? "…" : ""),
    landedAfterVerify: new URL(landed.url).pathname,
    trail: b.trail,
  };
}

out.A_signup_with_oauth_query_body = await attempt("resumeA", { callback: "oauth_query" });
out.B_signup_with_authorize_as_callbackURL = await attempt("resumeB", { callback: "authorize_url" });
out.C_prompt_create = await attempt("resumeC", { prompt: "create", callback: "authorize_url" });
save("04-signup-resume.json", out);
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify({ ...(v as object), trail: undefined }));
