/**
 * Operator-facing wording for provisioning outcomes, kept in a module with no
 * imports at all.
 *
 * Both halves of the saga need the same words: `src/control-plane.ts` writes
 * them to `provisioning_error` on the WABA row, and `src/provisioning.ts`
 * returns them to whoever asked. The control plane is a Durable Object and
 * imports `cloudflare:workers`, which the Bun test target cannot resolve — so a
 * shared constant cannot live there without dragging that dependency into every
 * plain unit test that touches a route. Hence this file: pure strings, no
 * runtime, importable from anywhere.
 *
 * Only messages that genuinely need both sides belong here. The short ones the
 * two files each spell out for themselves are left where they are; moving them
 * would be churn, not a fix.
 */

/**
 * A WABA that connected without a business phone number.
 *
 * Embedded Signup v4 made this reachable: a customer can finish the flow with a
 * verified number, an unverified number, or none at all, where v2 always
 * produced a verified one. The WABA is genuinely connected — its webhooks are
 * subscribed — there is simply nothing yet to send from, and the next move
 * belongs to the customer rather than to the operator.
 */
export const AWAITING_PHONE_NUMBER_ERROR =
  "connected, but this WhatsApp Business account has no business phone number yet; add one in WhatsApp Manager and Eccos will pick it up";
