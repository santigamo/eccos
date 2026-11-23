# Console OAuth authorization server

The console is the OAuth 2.1 authorization server MCP clients use: they read its metadata, register, send the person through sign-in, the workspace step and consent, then exchange the code and refresh. Some of these endpoints are called from other origins, and only the built console Worker answers their CORS preflight the way production does.

## Sub-features

- `oauth-metadata` serves the authorization server metadata at `/.well-known/oauth-authorization-server`.
- `oauth-cors` answers the preflight on the metadata, `oauth2/token`, `oauth2/register` and `jwks` with `*` and no credentials, and on nothing else.
- `oauth-register` registers a client anonymously, within a body cap of 8 KiB and per-field limits.
- `oauth-consent` shows the consent page on every authorization, a repeat one included.
- `oauth-token` exchanges a code and refreshes, and answers `invalid_grant` once the user has left the workspace.
- `oauth-client-cleanup` deletes registered and metadata-document clients that stayed unused for 24 hours, on the console's cron trigger.
- `oauth-authorize-limit` allows 10 authorization requests per minute per address; the 11th answers `429`.

## How to get to it (user POV)

- An MCP client starts at `http://localhost:3000/.well-known/oauth-authorization-server` and `POST http://localhost:3000/api/auth/oauth2/register`.
- The person's browser opens `/api/auth/oauth2/authorize?...`, signs in, and lands on `/oauth/workspace` and then `/oauth/consent`.

## Driving it with verify-eccos

Preconditions:

- A fresh launch for the vite dev entries. The built-Worker entries need ports 3100 and 3101 free and no launch of their own.

Entries:

- **Register, vite dev.** `curl -s -w ' [%{http_code}]' -X POST http://localhost:3000/api/auth/oauth2/register -H 'content-type: application/json' -H 'origin: https://client.example' -d '{"client_name":"Probe","redirect_uris":["https://client.example/cb"],"token_endpoint_auth_method":"none"}'` answers `201` with a `client_id`. The same call with a `client_name` of 9000 characters answers `400` `{"error":"invalid_client_metadata",...}`. More than five `redirect_uris` answer `400` `invalid_redirect_uri`. Five registrations per minute per address are accepted; the sixth answers `429`.
- **Build the Worker.** `cd apps/dashboard && bunx vite build`. It writes `dist/server/wrangler.json`.
- **Run the built Worker.** `cd apps/dashboard && bunx wrangler d1 migrations apply eccos-auth --local -c dist/server/wrangler.json --persist-to /tmp/oauth-built`, then start `bunx wrangler dev -c dist/server/wrangler.json --port 3100 --inspector-port 3101 --persist-to /tmp/oauth-built` as a server. Its own D1 lives under `/tmp/oauth-built`, apart from the launch's.
- **Preflight, built Worker.** `curl -s -i -X OPTIONS http://localhost:3100/api/auth/oauth2/token -H 'origin: https://client.example' -H 'access-control-request-method: POST'` answers `204` with `access-control-allow-origin: *`, `access-control-allow-methods: POST, OPTIONS` and no `access-control-allow-credentials`. The same preflight on `/api/auth/oauth2/revoke` or `/api/auth/oauth2/consent` answers `404` with no CORS header.
- **Oversized registration, built Worker.** A 1.9 MB registration body (`client_name` of 1,900,000 characters) answers `400` `invalid_client_metadata` after about a second, with or without `Transfer-Encoding: chunked`, and adds no row.
- **Cleanup, built Worker.** Register two clients against port 3100 and age one of them in the run's own D1 (`find /tmp/oauth-built -name '*.sqlite' ! -name metadata.sqlite`, then `UPDATE oauthClient SET createdAt = '2020-01-01T00:00:00.000Z' WHERE clientId = '<id>'`). `curl -s 'http://localhost:3100/cdn-cgi/handler/scheduled?cron=0+*+*+*+*'` answers `ok`. The aged client is gone: `GET /api/auth/oauth2/authorize` with its `client_id` answers `302` to `/api/auth/error?error=invalid_client`. The fresh one is still there, and so is an aged one that holds a consent, a refresh token or an access token.

## Gotchas

- Under `vite dev` (port 3000), Vite answers every `OPTIONS` itself, with `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE` and no allow-origin, before the console's code runs. A preflight there proves nothing about the console; check CORS on the built Worker only.
- The built Worker does not serve `/__scheduled`, even with `--test-scheduled`: that request reaches the console and gets `302` to `/signin`. Use `/cdn-cgi/handler/scheduled`.
- `/oauth/workspace` and `/oauth/consent` have no pages yet, so a browser lands on another screen. Drive those steps with `POST /api/auth/oauth2/continue` and `POST /api/auth/oauth2/consent` from the signed-in session, with `origin: http://localhost:3000`.
- Without `MCP_RESOURCE` an https deployment refuses every request; locally the resource is `http://localhost:8788/mcp`.
