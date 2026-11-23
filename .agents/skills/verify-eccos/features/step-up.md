# Step-up

Sensitive console actions need two-factor authentication (TOTP) and a step-up from the last 15 minutes. The table below lists every one of them: attaching a number, connection links, API keys, conversation retention, the forwarding target, resubscribing, and member changes. Without TOTP the action is refused and the console offers to set it up. With a step-up older than 15 minutes it asks for a code again. Reads are not gated.

## Sub-features

- `stepup-covers-source` keeps the table below equal to the server functions the source protects.
- `stepup-refused-without-totp` refuses every protected server function for a user without TOTP, while a read passes.
- `stepup-wrong-code` refuses a wrong TOTP code.
- `stepup-passes-after` lets every protected server function past the gate once TOTP is on and the step-up is fresh.
- `stepup-refused-when-aged` refuses every protected server function once the step-up is 16 minutes old.
- `stepup-console-setup` sets up TOTP from the dialog a sensitive action opens, then finishes that action.
- `stepup-console-confirm` keeps `Confirm it's you` open on a wrong code and finishes the action on the right one.

## How to get to it (user POV)

- Start any sensitive action, such as `Attach number` on `/numbers/attach-token`, `Create key` on `/api-keys`, or `Save` on `/webhooks`. The console opens the dialog it needs.
- Settings holds two-factor authentication for a user who sets it up first.

## Driving it with verify-eccos

Preconditions:

- Baseline launch. A new user with a workspace, in `$EMAIL`, with its organization id in `$ORG`, made over HTTP like this:
  - Sign up: `curl -s -X POST http://localhost:3000/api/auth/sign-up/email -H 'content-type: application/json' -H 'origin: http://localhost:3000' --data "{\"name\":\"Vera\",\"email\":\"$EMAIL\",\"password\":\"Verify-Passw0rd-2026!\"}"`.
  - Verify the address with `$V follow-mail-link $EMAIL`, then sign in with `$V session $EMAIL`.
  - Create the workspace with `$V serverfn $EMAIL src/organizations.ts createOrganization '{"name":"Verify Workspace"}'`. It prints `"ok": true` and the `organizationId` to put in `$ORG`.
- For the console steps, that user signed in in the browser, or the Console onboarding user before `onboard-attach`.

Protected server functions, with the input each recipe step sends. `<org>` is `$ORG`; `none` sends no input. The ids are placeholders: past the gate, those calls fail on a missing invitation, member, key or WABA, which still proves the gate let them through.

| File | Export | Input |
| --- | --- | --- |
| `src/members.ts` | `cancelInvitation` | `{"invitationId":"none"}` |
| `src/members.ts` | `inviteMember` | `{"email":"guest@eccos-verify.example","role":"operator","organizationId":"<org>"}` |
| `src/members.ts` | `removeMember` | `{"memberId":"none"}` |
| `src/members.ts` | `resendInvitation` | `{"invitationId":"none"}` |
| `src/members.ts` | `updateMemberRole` | `{"memberId":"none","role":"viewer"}` |
| `src/server/connect-block.ts` | `getConnectBlock` | `none` |
| `src/server/gateway.ts` | `connectWithToken` | `{"token":"EAAverifyFakeToken0000000000"}` |
| `src/server/gateway.ts` | `issueApiKey` | `{"label":"verify"}` |
| `src/server/gateway.ts` | `openConnectLink` | `{"fresh":true}` |
| `src/server/gateway.ts` | `resubscribe` | `{}` |
| `src/server/gateway.ts` | `revokeApiKey` | `{"keyId":"key_00000000000000000000000000000000"}` |
| `src/server/gateway.ts` | `setConversationRetention` | `{"days":30}` |
| `src/server/gateway.ts` | `setSubscriberConfig` | `{"url":"https://subscriber.eccos-verify.example/hook","secret":"verify-subscriber-secret"}` |
| `src/server/gateway.ts` | `startConnect` | `none` |

- **Covers the source.** Run `$V stepup-actions --check`. It lists the server functions that name a `STEP_UP_ROWS` row or call `requireStepUp`, and ends `step-up.md covers all 14 protected server functions`. A protected function missing from the table, or a table row the source no longer protects, makes it exit 1 and name the function.
- **Refused without TOTP.** Run `$V stepup-matrix $EMAIL $ORG before`. Every line reads `ok <export> refused: totp-required`, and it exits 0.
- **Reads pass.** Run `$V serverfn $EMAIL src/server/gateway.ts listApiKeys`. The output is `"ok": true` with `"data": []`, so the refusals are the step-up rule and not a broken session.
- **Enroll.** Run `$V enroll-totp $EMAIL`, which ends `TOTP on for ...`.
- **Wrong code.** Run `$V serverfn $EMAIL src/server/step-up.ts confirmStepUpCode '{"code":"000000"}'`. The output is `"ok": false`, `"code": "invalid"`. It spends one of the ten attempts before the lockout.
- **Passes after.** Run `$V stepup-matrix $EMAIL $ORG after`. Every line reads `ok <export> passed step-up:` followed by the result, and it exits 0. `issueApiKey` prints a new `ek_` key: mask it before saving the output.
- **Refused when aged.** Run `$V age-step-up $EMAIL`, then `$V stepup-matrix $EMAIL $ORG aged`. Every line reads `ok <export> refused: reauth-required`.
- **Right code again.** Run `$V step-up $EMAIL`. The output is `"ok": true`, and `$V stepup-matrix $EMAIL $ORG after` passes again.
- **Console setup.** On `/numbers/attach-token`, fill `Meta access token` with `EAAverifyFakeToken0000000000` and choose `Attach number`. The dialog `Set up two-factor authentication` opens.
  - Fill `Your password` and choose `Email me a code`. Fill `Code from your email` with the output of `$V mail-code <email>` and choose `Continue`.
  - The dialog shows a QR code and a key. Fill `Code` with `$V totp <key>` and choose `Turn on`.
  - The dialog `Save your backup codes` lists ten codes. Choose `Done`. The attach continues by itself and `/numbers` lists `+34 600 000 001` as `active`.
- **Console confirm.** Run `$V age-step-up <email>`, then on `/api-keys` fill `Label` and choose `Create key`. The dialog `Confirm it's you` opens.
  - Fill the textbox `Code` with `000000` and choose `Verify`. The alert `That code did not match. Check it and try again.` appears and the dialog stays open.
  - Fill `Code` with `$V totp <key>` (or `$V totp $EMAIL` for a user enrolled by `enroll-totp`) and choose `Verify`. The dialog closes and the page shows the new key under `New key`.

## Gotchas

- A sign-in that answers the TOTP prompt counts as a step-up, so a user who just signed in with TOTP passes the gate. `$V age-step-up` moves that user's `stepUpAt` 16 minutes back in the console's local database; it changes nothing else.
- A TOTP code works once. Within one 30-second window, a second use answers `used`. The helper waits for the next window; when you type codes by hand, wait too.
- Ten wrong codes lock the account for 15 minutes, for sign-in and step-up alike.
- `openConnectLink` is gated only when it issues a link. Without `"fresh":true` it hands back a pending link that already exists, step-up or not, which is why the table sends `fresh`.
- `getConnectBlock` is a read that reports which step-up connecting still needs. It does not refuse: before TOTP it answers `totp-required`, and after a fresh step-up it answers `null`.
- `$V mail-code` reads the code from the fake's mail log. The real mail provider is never called.
- Backup codes, password change, disabling TOTP and Settings' own two-factor screen are not mapped yet.
