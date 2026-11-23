# Console onboarding

A new customer creates an account in the operator console, verifies their email, names a workspace, and lands on a console scoped to that workspace. The sidebar then leads to the setup and log screens.

## Sub-features

- `onboard-signup` creates an account and sends a verification email.
- `onboard-verify` verifies the address from the emailed link and allows sign-in.
- `onboard-workspace` creates the workspace and its gateway account.
- `onboard-attach` connects the first number. Recipe in [Connect and provisioning](./connect-and-provisioning.md).
- `onboard-forwarding` saves a forwarding target on Webhooks.
- `console-events` shows received events on Events.
- `console-conversations` shows a customer's messages on Conversations.
- `console-api-key` creates an API key that the gateway accepts.

## How to get to it (user POV)

- Open `http://localhost:3000/signup`, or choose `Create your account` on `/signin`.
- Open the link in the verification email.
- After sign-in, use the sidebar links `Numbers`, `Webhooks`, `API keys`, `Conversations`, `Templates`, `Messages`, `Events`.

## Driving it with verify-eccos

Preconditions:

- A fresh launch.
- An email never used on this machine, in `$EMAIL`, such as `vera+20261123T1300@eccos-verify.example`.

- **Sign up.** Open `http://localhost:3000/signup`. Fill the textbox `Name` with `Vera Verify`, `Email` with `$EMAIL`, `Password` with `Verify-Passw0rd-2026!`, choose the button `Create account`. The heading becomes `Check your inbox` and the page shows `$EMAIL`.
- **Mail sent.** Run `$V fake-log /mail/`. The newest line has `"template":"verify-email"` and `"to":"$EMAIL"`.
- **Verify.** Open the URL printed by `$V mail-link $EMAIL` in the same browser, or run `$V follow-mail-link $EMAIL`, which prints `HTTP 302 -> http://localhost:3000/`.
- **Sign in.** Open `http://localhost:3000/signin`. Fill `Email` and `Password`, choose the button `Sign in`. The page moves to `/onboarding` with the heading `Create your workspace`.
- **Workspace.** Fill the textbox `Workspace name` with `Verify Workspace`, choose the button `Create workspace`. The page moves to `/numbers`, the breadcrumb button reads `Workspace: Verify Workspace`, and the heading is `Connect WhatsApp`.
- **Attach.** Follow `connect-attach-token`. The `Setup` checklist then marks `Number` done.
- **Forwarding.** Open `http://localhost:3000/webhooks`. Fill the textbox `Forwarding URL` with `https://subscriber.eccos-verify.example/hook` and `Signing secret` with `verify-subscriber-secret`, choose the button `Save`. A status reads `Saved. Forwarding target updated.`, the page badge changes from `no target` to `forwarding`, `Signing` reads `secret set`, and the `Setup` checklist marks `Forwarding target` done.
- **Events.** Run `$V webhook .agents/skills/verify-eccos/fixtures/inbound-text.json`, then open `http://localhost:3000/events`. The counter reads `1 event` and one row shows a button `Inspect event 1` reading `reply`, then `from +34611111111`, `hola`, and the forward state `forwarded` (drawn in capitals as `FORWARDED`). Before the webhook the table reads `NO EVENTS YET`.
- **Conversations.** Open `http://localhost:3000/conversations`. A link starting `Ana` shows `hola` and `1 unread messages`. Choose it. The heading becomes `Ana`, the thread shows `Customer`, `hola`, the note `Window open, 23 h left`, a textbox `Reply` and a disabled button `Send`.
- **API key.** Open `http://localhost:3000/api-keys`. Fill the textbox `Label` with `verify`, choose the button `Create key`. Under `New key` the page shows the key, which starts `ek_`, with the buttons `Copy` and `Done`. It is shown once: after `Done` or a reload only the table row remains, with the label `verify` and an ID starting `key_`. Do not screenshot the page while the key is visible. Use it as `$KEY` in `curl -s -w ' [%{http_code}]' http://localhost:8787/v1/wabas/100200300/templates -H "authorization: Bearer $KEY"`. The status is `200`.

## Gotchas

- Sign-in before verification is refused. Without the mail link there is no way in.
- Some harnesses mask token-like strings in tool output, which breaks the printed link. `$V follow-mail-link` avoids that, but it verifies outside the browser, so the browser still has to sign in.
- The dashboard's auth database outlives `$V stop`. A reused email does not fail visibly: the sign-up request (`POST /api/auth/sign-up/email`) still answers `200`, but no mail is sent, so `$V fake-log /mail/` gains no line and `$V mail-link` prints the old link. A user from an earlier run can still sign in, and gets a new, empty gateway account, because gateway state resets on launch.
- Before a number is attached, most sidebar entries are plain text, not links.
- The console only answers on `localhost:3000`. The dev server listens on IPv6 loopback only, so `http://127.0.0.1:3000` refuses the connection. A request with any other `Host` header, such as `example.com`, gets `403`.
- Members, invitations, billing, settings, password reset, the Spanish `/connect` page and broadcasts are not mapped yet.
