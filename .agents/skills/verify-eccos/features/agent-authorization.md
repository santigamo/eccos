# Agent authorization

A person connects an MCP agent to one workspace through the console's OAuth authorization server. The agent registers, opens the authorize URL, and the person signs in or signs up, picks or names a workspace, and approves the scopes. The agent then gets a code and exchanges it for a token bound to that workspace.

## Sub-features

- `oauth-register` registers a client by dynamic client registration.
- `oauth-signup-resume` carries the authorization through sign-in, sign-up and the mailed verification link.
- `oauth-workspace` picks one of the user's workspaces, or names the first one.
- `oauth-consent` shows the agent's name, the host it returns to, the workspace and each scope, and sends only the ticked scopes. Deny returns `access_denied`.
- `oauth-token` exchanges the code with PKCE. The access token names the workspace.

## How to get to it (user POV)

- An agent opens `http://localhost:3000/api/auth/oauth2/authorize?...`. Without a session that lands on `/signin` with the signed query; `Create your account` keeps it.
- After sign-in, or after the mailed link, the page is `/oauth/workspace`, then `/oauth/consent`, then the agent's redirect URI.

## Driving it with verify-eccos

Preconditions: a fresh launch, a new email in `$EMAIL`, and a redirect URI the browser can load whose full URL you can read without a tool masking it. A small local listener works, such as one on `http://127.0.0.1:8799/callback` that appends each request URL to a file. Loopback `http` redirect URIs are accepted.

- **Register.** `curl -s -w ' [%{http_code}]' -X POST http://localhost:3000/api/auth/oauth2/register -H 'content-type: application/json' -d '{"client_name":"Proof Agent","redirect_uris":["http://127.0.0.1:8799/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}'` answers `201` with a `client_id`.
- **Authorize.** Make a PKCE verifier and its S256 challenge, then open `http://localhost:3000/api/auth/oauth2/authorize` with `response_type=code`, the `client_id`, the `redirect_uri`, `scope=eccos:view eccos:operate eccos:send eccos:configure eccos:administer offline_access`, `resource=http://localhost:8788/mcp`, a `state`, `code_challenge` and `code_challenge_method=S256`. The page is `/signin`, and its query holds `sig`.
- **Sign up.** Choose the link `Create your account`. The page is `/signup` and its query still holds `sig`. Sign up as in [Console onboarding](./console-onboarding.md).
- **Verify.** Open the mailed link in the same browser. Its `callbackURL` is `/api/auth/oauth2/authorize?...`, and the page lands on `/oauth/workspace` with the heading `Create your workspace`. `$V follow-mail-link` verifies outside the browser, so the authorization does not resume that way; open the authorize URL again and sign in instead.
- **Workspace.** Fill `Workspace name`, choose `Create workspace`. The page is `/oauth/consent`, heading `Connect an agent`, with `Agent` showing the client name, `Returns to` the redirect host, `Workspace` the name, and one checkbox per scope except `offline_access`. The API keys page of that workspace later reads `No keys yet`.
- **Consent.** Untick `Send messages`, choose `Allow`. The browser lands on the redirect URI with `code`, `state` and `iss=http://localhost:3000`.
- **Token.** `POST http://localhost:3000/api/auth/oauth2/token` (form) with `grant_type=authorization_code`, the code, the verifier, the `client_id`, the `redirect_uri` and the `resource`. It answers `200`. The access token's payload has `aud` `http://localhost:8788/mcp`, a `scope` without `eccos:send`, and `https://eccos.chat/workspace` set to the workspace's id.
- **Two workspaces.** Signed in with a second workspace (`/workspaces/new`), register a second client and authorize again. `/oauth/workspace` lists both as buttons. Choose the one that is not active; the token names that one.
- **Deny.** On consent choose `Deny`. The redirect URI gets `error=access_denied` and the `state`.

## Gotchas

- Tool output may mask the query values of these URLs. Let a script read the code from the listener's file and keep tokens out of evidence.
- A client that already holds a consent for the same user, workspace and scopes skips the consent page and returns a code right after the workspace step.
- Opened without a session, `/oauth/workspace` and `/oauth/consent` go to `/signin` carrying only the signed parameters.
