# Changelog

## Unreleased

### Business-scoped user IDs (BSUIDs)

Meta now names some WhatsApp users by a business-scoped user id (BSUID, e.g.
`US.13491208655302741918`, or `US.ENT.…` for a parent BSUID) and withholds their phone number.

- **Forwarded events (additive, check your validation):** `reply` / `message` carry `fromUserId`
  and `echo` / `message_echo` carry `toUserId` whenever Meta sends a BSUID. When Meta withholds the
  number, `from` / `to` is the BSUID instead of a phone number. A subscriber that validates
  `from` / `to` as E.164 must accept a BSUID too.
- **Send (Workers):** `POST /v1/wabas/<id>/messages` and the console sends accept `to` as a phone
  number or a BSUID; a BSUID is sent to Meta as `recipient`. The public route also takes Meta's own
  `recipient` (a BSUID) when `to` is absent; if both are sent, `to` wins. Any other recipient is now
  a `400` (previously anything of 5+ characters was passed to Meta). Meta refuses one-tap, zero-tap and
  copy-code authentication templates to a BSUID (error `131062`).
- **Erasure (Workers):** `POST /v1/wabas/<id>/privacy/erasure` accepts a BSUID in `phone`.
- **History sync:** app-state contacts that Meta sends with only a BSUID are now stored.
