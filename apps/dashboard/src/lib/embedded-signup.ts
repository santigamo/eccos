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
 * Which onboarding a customer picked, before Meta's popup opens.
 *
 * This is a CHOICE THE CUSTOMER MAKES, not a mode the code detects, and it has
 * to be made first: `featureType` travels in `FB.login`'s `extras`, so it is
 * fixed at the moment the popup is spawned and cannot be decided later.
 *
 *  - `business-app` — coexistence. The number stays on the WhatsApp Business
 *    app and the customer keeps answering there; Eccos syncs contacts and
 *    history.
 *  - `new-number`   — the ordinary Cloud API onboarding. Meta asks for a number
 *    and verifies it, and that number is then served by the API alone.
 */
export type ConnectPath = "business-app" | "new-number";

/** Meta's value for the WhatsApp Business app (coexistence) flow. */
export const COEXISTENCE_FEATURE_TYPE = "whatsapp_business_app_onboarding" as const;

/**
 * The `FB.login` options for Embedded Signup v4.
 *
 * ── WHY `extras` IS NOT EMPTY, AND HOW WE LEARNED IT ─────────────────────────
 * This function used to send `extras: { setup: {} }`, on the documented
 * reading that v4's extras object is "purposely empty" and that `featureType`,
 * `sessionInfoVersion` and `version` were the v2/v3 mechanism replaced by
 * `config_id`. That reading is wrong, and it cost us the coexistence flow
 * entirely: with an empty extras, Meta serves the ordinary Cloud API
 * onboarding and a customer whose number is on the WhatsApp Business app has
 * no way to reach it.
 *
 * The correction did not come from the docs. It came from Meta's OWN generator
 * — App Dashboard > WhatsApp > Embedded Signup creator > "Cuadro de diálogo de
 * registro insertado" — which, for THIS app and THIS v4 configuration, builds
 * its landing URL with, verbatim after decoding:
 *
 *   {"featureType":"whatsapp_business_app_onboarding",
 *    "sessionInfoVersion":"3",
 *    "version":"v4"}
 *
 * All three keys, on v4, in extras. The panel exposes the first as an optional
 * "Tipo de función" selector with exactly two values — none, and WhatsApp
 * Business app onboarding — which is the whole feature: coexistence was never
 * something Meta had to enable for us, it is a per-launch parameter we were
 * not sending. `setup` is dropped because Meta's generator does not emit it;
 * it was always `{}` here, and it is where prefilled data would go if we ever
 * prefilled any.
 *
 * ── WHY THIS ONLY WORKS ON THE SDK PATH ─────────────────────────────────────
 * `extras` is an `FB.login()` option and a parameter of Meta's hosted landing
 * page. It is NOT a parameter of `dialog/oauth`, and we proved on 2026-09-01
 * that Meta silently ignores it there (eccos-e3q). That is not a gap to close:
 * Meta's own requirements list for coexistence ends with "you must use
 * Embedded Signup with session logging", which exists only in the SDK. So
 * **coexistence is SDK-only by construction**, and the server-side redirect
 * fallback must refuse it rather than quietly serve the other flow — see
 * `connect-number.tsx`.
 *
 * Two things below are load-bearing for reasons unrelated to any of the above:
 * `response_type: "code"` with `override_default_response_type: true` is what
 * returns an exchangeable code instead of a client token (a client token would
 * be useless — the exchange needs the app secret and must happen server-side),
 * and `config_id` still carries the products and permissions.
 */
export interface EmbeddedSignupLoginOptions {
  config_id: string;
  response_type: "code";
  override_default_response_type: true;
  extras: {
    sessionInfoVersion: "3";
    version: "v4";
    featureType?: typeof COEXISTENCE_FEATURE_TYPE;
  };
}

export function loginOptions(configId: string, path: ConnectPath): EmbeddedSignupLoginOptions {
  return {
    config_id: configId,
    response_type: "code",
    override_default_response_type: true,
    extras: {
      sessionInfoVersion: "3",
      version: "v4",
      ...(path === "business-app" ? { featureType: COEXISTENCE_FEATURE_TYPE } : {}),
    },
  };
}
