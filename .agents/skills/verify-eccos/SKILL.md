---
name: verify-eccos
description: Drive a local Eccos stack the way a user does and capture proof. Covers the Workers gateway (webhook intake, send, templates, connect, provisioning) over HTTP and the operator console (apps/dashboard) in a browser, with Meta, the subscriber and the mail provider replaced by a local fake. Use it to prove a gateway or console change works before opening a PR, or to reproduce a bug. No Meta or Cloudflare credentials needed.
---

# Verify Eccos

Everything runs through one helper. Run it from the repository root.

```bash
V=.agents/skills/verify-eccos/scripts/verify-eccos
```

Read [features/README.md](features/README.md) before driving. It indexes one recipe per feature.

## What runs

| Process | Address | What it is |
| --- | --- | --- |
| gateway | http://localhost:8787 | `wrangler dev` on `harness/gateway-entry.ts`, which wraps the unmodified `apps/gateway/src/worker.ts` |
| dashboard | http://localhost:3000 | `vite dev` in `apps/dashboard`, bound to the gateway over the `GATEWAY` RPC service binding. Reach it as `localhost`; it does not listen on `127.0.0.1` |
| fake | http://127.0.0.1:8790 | `harness/fake-meta.ts`: Meta Graph API, a subscriber endpoint and the mail provider |

The gateway entry changes one thing: outbound requests to `graph.facebook.com` and to `subscriber.eccos-verify.example` go to the fake. The dashboard sends mail to the fake through its own `RECCADO_ENDPOINT` setting. The console runs from `harness/dashboard.vite.config.ts`, the same plugins as `apps/dashboard/vite.config.ts` pointed at a copy of its `wrangler.jsonc` under `.verify/run/dashboard`. No other code path differs from production code.

The stack never reads your local environment. Both processes start with an empty environment apart from `PATH`, `HOME` and `TMPDIR`, and with no `.dev.vars` or `.env` beside their config: the gateway gets `--env-file .verify/run/empty.env`, and the console's config lives in the run directory. A `.dev.vars` you keep for your own `vite dev` or `wrangler dev` stays untouched and unused. All secrets are fixed fake values printed by `$V env`.

The fake knows one WhatsApp Business Account: WABA `100200300`, phone number ID `555001`, display number `+34 600 000 001`, and one approved template `order_update` (`en_US`, id `900100`). It keeps templates per WABA: a create adds a `PENDING` row to that WABA, an edit (`POST /<template id>`) replaces the row's content at once, and a delete removes it; another WABA starts with none. Any Meta token is accepted. A send to `34600000999` is refused with Meta error `131026`. A Graph request the fake has no answer for returns a Meta-style `400` and is logged with `"handled":false`.

## Launch

```bash
$V launch
```

It installs dependencies if missing, starts the three processes, applies the dashboard's D1 migrations, waits until each is usable, then runs the doctor. It takes about 40 seconds. Ready is the final line `doctor: healthy.`. It refuses to start when a run already exists or when port 8787, 3000 or 8790 is taken.

Gateway state starts empty on every launch (`.verify/run/gateway-state`). The dashboard's auth database does not: it lives in `apps/dashboard/.wrangler/state`, shared with your own `vite dev` sessions, and survives `stop`. Use a new email address for every run.

Only one stack runs per machine. The ports and the worker name `eccos` in wrangler's dev registry are fixed.

## Doctor

```bash
$V doctor
```

It checks that the three processes are the ones this run started and own their ports, that the gateway reports its secrets and control plane ready, that both run the harness and loaded no `.dev.vars` or `.env`, and that the dashboard serves `/signin`. Last, it signs up a throwaway `doctor+<time>@eccos-verify.example` user and waits for that mail in the fake's log, so a console wired to a real mail provider fails here. That sign-up is the only thing it writes. Run it first whenever something looks off. On `FAIL`, read `.verify/run/<name>.log`.

## Drive

Gateway, over HTTP:

- `$V webhook <file>` signs a Meta webhook body with the app secret and posts it to `/webhooks/meta`. `$V webhook <file> --bad-signature` posts it with a wrong signature. Bodies live in `fixtures/`; `__NOW__` in a body becomes the current Unix time, so the 24-hour reply window is always open.
- `$V admin <METHOD> <path> [json]` calls an admin bootstrap route with the admin key.
- Account routes take `curl` with `authorization: Bearer <api key>`. Get a key from the console's API keys page or from `$V admin POST /v1/accounts '{"accountId":"<id>"}'`.

Console, over HTTP without the UI, for server-side checks such as refusals:

- `$V session <email>` signs in and keeps the cookie under `.verify/run/sessions/`. Once `enroll-totp` ran for that email, it answers the TOTP prompt itself, and that sign-in counts as a fresh step-up.
- `$V serverfn <email> <src file> <export> [json]` calls a console server function the way the browser does, with the file relative to `apps/dashboard`. For example: `$V serverfn $EMAIL src/server/gateway.ts issueApiKey '{"label":"verify"}'`. It prints the status and the decoded result. It is the user path minus the UI, so say so in a proof.
- `$V enroll-totp <email>` turns on TOTP for a signed-in user. The setup code is mailed through the fake, and the secret stays in the run directory. `$V step-up <email>` confirms with a fresh code. `$V totp <email|key>` prints the current code; `$V mail-code <email>` prints the newest setup code mailed to that address. Use the last two in the console's own dialogs. `$V age-step-up <email>` makes a step-up 16 minutes old, so the console asks again. `$V stepup-actions --check` and `$V stepup-matrix` drive the [Step-up](features/step-up.md) recipe.

Every command that sends a request to the stack (`webhook`, `admin`, `follow-mail-link`, `session` and the commands after it) first checks that the processes this run launched still own the ports. Otherwise it refuses, sends nothing and writes nothing, so it never posts the fixed password or a webhook to someone's own `vite dev` on port 3000.

Console, in a browser: use whatever browser automation your harness has. Address elements by route and by ARIA role and name, as the feature files list them. Do not wait for network idle. The console polls, so wait for the element or text you expect.

External side effects:

- `$V fake-log [filter]` prints every request the stack made to Meta, the subscriber or the mail provider, as JSONL. The filter matches anywhere in the line. `$V fake-log /555001/messages` shows sends, `$V fake-log /subscriber/` shows forwarded events. A bare `/messages` also matches the mail provider's path, so it prints the verification mail and its link.
- `$V mail-link <email>` prints the newest link mailed to that address. `$V follow-mail-link <email>` opens it with `curl`. Use the second form when your harness masks tokens in tool output, then sign in with the password.

## Evidence

```bash
E=$($V evidence <feature-id>)
```

This creates `.verify/evidence/<UTC time>-<feature-id>/` and prints it. Put every artifact there.

A proof holds:

- The user path: the real route, form or HTTP endpoint. Never a Durable Object method, an RPC call or a database write.
- The action and the resulting state. For HTTP, save the command, status and body. For the console, save a screenshot or ARIA snapshot before and after.
- The side effect. A send is proven by the request in `$V fake-log /555001/messages`. A forward is proven by the request in `$V fake-log /subscriber/` with its `x-eccos-signature`. A stored event is proven by a second view: the console's Events page or `GET /v1/wabas/100200300/export`.
- `cp .verify/run/fake.jsonl "$E/"` and `cp .verify/run/gateway.log "$E/"` before stopping.
- No secrets in evidence. `fake.jsonl` holds the mailed verification link with its `token=` value, and the API keys page shows a new key (`ek_...`) in full, on screen and in its ARIA text, until you choose `Done` or reload. Mask both (`sed -E 's/token=[^&" \\]*/token=<omitted>/g; s/ek_[A-Za-z0-9_-]+/ek_<omitted>/g'`) and do not screenshot the page while the new key is visible.

The fake stands in for Meta, so nothing here proves Meta accepts a payload. Say so in the proof. Behavior behind Meta's own UI (the Embedded Signup dialog) is out of reach. See each feature's Gotchas.

When a journey needs tighter control than a running stack gives (an alarm at a chosen time, a Meta response the fake does not model), use the Workers specs: `cd apps/gateway && bunx vitest run tests/worker/<name>.spec.ts`. That is a test, not a user-path proof. Report it as such.

## Cleanup

```bash
$V stop
```

It stops the three process groups it started, by PID, and deletes `.verify/run`. It never kills by name and never touches `.verify/evidence`. Run it after a failed launch too. `.verify/` is ignored by Git.

## Maintenance

When a route, label or flow changes, update the matching file in `features/` in the same PR. When the gateway starts calling a new Graph endpoint, add its answer to `harness/fake-meta.ts`.
