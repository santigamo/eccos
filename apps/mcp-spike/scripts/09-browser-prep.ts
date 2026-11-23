// Prepares a real-browser run of the consent visit: a verified user with a workspace, a client, an authorize URL.
import { CONSOLE, RESOURCE, newUser, pkce } from "./lib";
const { email } = await newUser("browser", "Browser Workspace");
const REDIRECT = "http://127.0.0.1:53682/callback";
const { client_id } = (await (await fetch(CONSOLE + "/api/auth/oauth2/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Spike Browser Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json()) as { client_id: string };
const u = new URL(CONSOLE + "/api/auth/oauth2/authorize");
u.search = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "browser", resource: RESOURCE, scope: "eccos:view eccos:administer offline_access" }).toString();
console.log(JSON.stringify({ email, authorize: u.href }));
