/**
 * Meta Embedded Signup session logging, parsed safely.
 *
 * Meta's "Onboard WhatsApp Business app users" requirements list ends with
 * *"You must use Embedded Signup with session logging"* — the `message` event
 * listener on the page that spawned the flow. It is the only source of two
 * things nothing else reports: **which screen a customer abandoned on**, and
 * the **error code and session id** when they use the flow's own error
 * reporter. The asset ids it also carries are already obtained server-side from
 * the token exchange, so this listener is telemetry, not a data path.
 *
 * ── ORIGIN CHECKING ─────────────────────────────────────────────────────────
 * Meta's published sample gates on `event.origin.endsWith('facebook.com')`,
 * which also accepts `https://notfacebook.com` and `https://evil-facebook.com`.
 * Since this payload is forwarded to the audit log, we do not copy that bug:
 * `isMetaOrigin` parses the origin and requires https plus a hostname that is
 * exactly `facebook.com` or a subdomain of it. Anything else is dropped.
 *
 * Nothing here ever touches the authorization code. That arrives through
 * `FB.login`'s response callback, has a 30-second TTL, and goes straight to the
 * server — it is deliberately not part of this shape, so no future change to
 * the audit payload can start logging it.
 */

/** The `type` Meta stamps on every Embedded Signup session message. */
export const SESSION_EVENT_TYPE = "WA_EMBEDDED_SIGNUP";

/**
 * A parsed session event, reduced to fields that are safe to record: the flow
 * outcome, the screen a customer stopped on, Meta's support references, and the
 * asset ids (which are non-secret identifiers the operator already sees).
 */
export interface SessionEvent {
  /** `FINISH`, `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `CANCEL`, `ERROR`… */
  event: string;
  /** Screen the customer was on when they abandoned the flow. */
  currentStep?: string;
  /** Meta's error code, when the customer reported an error from inside the flow. */
  errorCode?: string;
  /** Meta's session id — the one thing support asks for. */
  sessionId?: string;
  wabaId?: string;
  phoneNumberId?: string;
}

/** https, and `facebook.com` or a subdomain of it. Deliberately stricter than Meta's sample. */
export function isMetaOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "facebook.com" || host.endsWith(".facebook.com");
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one `message` event into a recordable session event, or null.
 *
 * Null for: an origin that is not Meta's, a payload that is not JSON, and
 * anything that is not a `WA_EMBEDDED_SIGNUP` message — the Embedded Signup
 * popup is not the only thing that can post to this window, so silence is the
 * correct response to everything else, not an error.
 */
export function parseSessionEvent(origin: string, data: unknown): SessionEvent | null {
  if (!isMetaOrigin(origin)) return null;
  let payload: unknown = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const record = asRecord(payload);
  if (!record || record.type !== SESSION_EVENT_TYPE) return null;
  const event = str(record.event);
  if (!event) return null;
  const inner = asRecord(record.data) ?? {};
  return {
    event,
    ...(str(inner.current_step) ? { currentStep: str(inner.current_step) } : {}),
    ...(str(inner.error_code) ? { errorCode: str(inner.error_code) } : {}),
    ...(str(inner.session_id) ? { sessionId: str(inner.session_id) } : {}),
    ...(str(inner.waba_id) ? { wabaId: str(inner.waba_id) } : {}),
    ...(str(inner.phone_number_id) ? { phoneNumberId: str(inner.phone_number_id) } : {}),
  };
}

/**
 * Did the customer finish? Every `FINISH*` variant counts, including
 * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (coexistence) and `FINISH_ONLY_WABA`
 * (no phone number). Meta also treats closing the popup on the final screen as
 * success, so a `CANCEL` after a `FINISH` is not a retraction.
 */
export function isFinishEvent(event: string): boolean {
  return event.startsWith("FINISH");
}

/**
 * The `FB.login` options for Embedded Signup v4.
 *
 * Pinned in one place, and pure, because the shape is the whole contract with
 * Meta and it has changed under us before. Three things are load-bearing:
 *
 *  - `response_type: "code"` with `override_default_response_type: true` is what
 *    makes the callback return an exchangeable code instead of a client token.
 *    A client token would be useless: the exchange needs the app secret and must
 *    happen server-side.
 *  - `config_id` carries the entire flow definition under v4 — products,
 *    permissions, and the version itself. There is nothing else to send.
 *  - `extras` is `{ setup: {} }`, exactly as Meta's v4 implementation sample has
 *    it. No `featureType`, no `sessionInfoVersion`, no `version`: those were the
 *    v2/v3 mechanism, and v4's extras object is documented as purposely empty
 *    apart from `setup` (which is where pre-filled data would go if we ever
 *    pre-filled any).
 */
export interface EmbeddedSignupLoginOptions {
  config_id: string;
  response_type: "code";
  override_default_response_type: true;
  extras: { setup: Record<string, never> };
}

export function loginOptions(configId: string): EmbeddedSignupLoginOptions {
  return {
    config_id: configId,
    response_type: "code",
    override_default_response_type: true,
    extras: { setup: {} },
  };
}
