# Eccos verification map

This directory is the maintained source for verifying what Eccos users can observe. Read this index, then follow the matching feature file. `$V` is `.agents/skills/verify-eccos/scripts/verify-eccos`, run from the repository root.

## Baseline preconditions

- `$V launch` ended with `doctor: healthy.`.
- Run the baseline the way contributors have their checkout: with `apps/dashboard/.dev.vars` copied from `.dev.vars.example` as `apps/dashboard/README.md` says. Doctor must still be healthy, and the sign-up mail must still reach `$V fake-log /mail/`. A stack that reads that file sends mail elsewhere and cannot finish Console onboarding.
- Never drive a stack this run did not launch.
- Most recipes need an active number. Get one in either way and say which you used:
  - **Console baseline.** Follow [Console onboarding](./console-onboarding.md) through `onboard-attach`. This is the user path.
  - **API baseline.** Run the three commands under `provision-admin` in [Connect and provisioning](./connect-and-provisioning.md). The account is then `acme`, with no console user.
- The fake's fixed identifiers: WABA `100200300`, phone number ID `555001`, customer `34611111111` (Ana), undeliverable recipient `34600000999`.

## Driving conventions

- Start each recipe from a fresh launch unless its preconditions name another recipe. Several recipes can also share one launch in this order: Console onboarding, Webhook intake, Send a message, Templates. State carries over, and each recipe says where that changes what you see.
- Treat every command as literal.
- In the console, address elements by route, ARIA role and accessible name. Wait for the expected text, not for network idle.
- Use a new sign-up email on every run, such as `vera+<UTC time>@eccos-verify.example`.

## Proof and skip reporting

- Save artifacts under `E=$($V evidence <feature-id>)`.
- HTTP proof: command, status code and body.
- Console proof: a screenshot or ARIA snapshot of the action and of the resulting state.
- Side-effect proof: the matching lines of `$V fake-log`, or a second read through the console or `/export`.
- Report an unreachable path with the command you tried and the unmet precondition. Never report a skipped entry point as verified through another one.
- The fake answers for Meta. A pass here does not prove Meta accepts the request.
- Keep API keys (`ek_...`) and the mailed link's `token=` value out of evidence files and reports. See Evidence in `SKILL.md`.

## Feature entry contract

Each file has an H1, one paragraph, then four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-eccos`, `Gotchas`. Keep implementation details out. Name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Webhook intake](./webhook-intake.md) covers Meta's verification challenge, signature checks, ingest, dedup, and forwarding to the subscriber.
- [Send a message](./send-message.md) covers the public send API, Meta refusals, auth, and replying from Conversations.
- [Templates](./templates.md) covers listing templates over the API and in the console.
- [Connect and provisioning](./connect-and-provisioning.md) covers attaching a number by token, admin bootstrap, and the provisioning states.
- [Console onboarding](./console-onboarding.md) covers sign-up, email verification, workspace creation, and the log screens.
- [Step-up](./step-up.md) covers TOTP setup, the `Confirm it's you` challenge, and the server-side refusals of sensitive actions.
