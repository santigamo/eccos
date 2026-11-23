# Step-up

Sensitive console actions need two-factor authentication (TOTP) and a step-up from the last 15 minutes. They include attaching a number, connection links, API keys, the forwarding target, conversation retention and member changes. Without TOTP, the action is refused and the console offers to set it up. With a step-up older than 15 minutes, it asks for a code again. Reads are not gated.

## Sub-features

- `stepup-refused-without-totp` refuses a sensitive server function for a user without TOTP, while a read passes.
- `stepup-console-setup` sets up TOTP from the dialog a sensitive action opens, then finishes that action.
- `stepup-passes-after` lets the same server function through once TOTP is on and the step-up is fresh.
- `stepup-console-confirm` answers `Confirm it's you` with a TOTP code.

## How to get to it (user POV)

- Start any sensitive action, such as `Attach number` on `/numbers/attach-token` or `Create key` on `/api-keys`. The console opens the dialog it needs.
- Settings holds two-factor authentication for a user who sets it up first.

## Driving it with verify-eccos

Preconditions:

- Baseline launch. A new user with a workspace, in `$EMAIL`, made over HTTP like this:
  - Sign up: `curl -s -X POST http://localhost:3000/api/auth/sign-up/email -H 'content-type: application/json' -H 'origin: http://localhost:3000' --data "{\"name\":\"Vera\",\"email\":\"$EMAIL\",\"password\":\"Verify-Passw0rd-2026!\"}"`.
  - Verify the address with `$V follow-mail-link $EMAIL`, then sign in with `$V session $EMAIL`.
  - Create the workspace with `$V serverfn $EMAIL src/organizations.ts createOrganization '{"name":"Verify Workspace"}'`, which prints `"ok": true`.
- For the console steps, that user signed in in the browser, or the Console onboarding user before `onboard-attach`.

- **Refused without TOTP.** Run `$V serverfn $EMAIL src/server/gateway.ts issueApiKey '{"label":"verify"}'`. The output is `HTTP 200` with `"ok": false`, `"kind": "forbidden"`, `"reason": "totp-required"`. `setConversationRetention` with `'{"days":30}'` is refused the same way.
- **Reads pass.** Run `$V serverfn $EMAIL src/server/gateway.ts listApiKeys`. The output is `"ok": true` with `"data": []`, so the refusal above is the step-up rule and not a broken session.
- **Passes after.** Run `$V enroll-totp $EMAIL`, which ends `TOTP on for ...`, then the `issueApiKey` call again. The output is `"ok": true` with a `keyId` and an `apiKey` starting `ek_`. Mask the key before saving the output.
- **Console setup.** On `/numbers/attach-token`, fill `Meta access token` with `EAAverifyFakeToken0000000000` and choose `Attach number`. The dialog `Set up two-factor authentication` opens.
  - Fill `Your password` and choose `Email me a code`. Fill `Code from your email` with the output of `$V mail-code <email>` and choose `Continue`.
  - The dialog shows a QR code and a key. Fill `Code` with `$V totp <key>` and choose `Turn on`.
  - The dialog `Save your backup codes` lists ten codes. Choose `Done`. The attach continues by itself and `/numbers` lists `+34 600 000 001` as `active`.
- **Console confirm.** When `Confirm it's you` opens, fill the textbox `Code` with `$V totp <key>` (or `$V totp $EMAIL` for a user enrolled by `enroll-totp`) and choose the button `Verify`. The action continues.

## Gotchas

- The `Confirm it's you` labels come from the console source; this recipe has not been driven through that dialog, because it only appears once the step-up is 15 minutes old.
- A sign-in that answers the TOTP prompt counts as a step-up. So a user who just signed in with TOTP passes the gate. To see `reauth-required` you have to wait out the 15 minutes; the harness has no clock control. `apps/dashboard/tests/step-up*.test.ts` covers that case as a test.
- A TOTP code works once. Within one 30-second window, a second use answers `used`. The helper waits for the next window; when you type codes by hand, wait too.
- Ten wrong codes lock the account for 15 minutes, for sign-in and step-up alike.
- `$V mail-code` reads the code from the fake's mail log. The real mail provider is never called.
- Backup codes, password change, disabling TOTP and Settings' own two-factor screen are not mapped yet.
