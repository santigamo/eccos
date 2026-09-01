/**
 * Loading Meta's JavaScript SDK — the only third-party script in this console.
 *
 * ── WHY IT IS HERE AT ALL ───────────────────────────────────────────────────
 * Meta's coexistence requirements end with *"You must use Embedded Signup with
 * session logging"*, and session logging is a `message` listener on the window
 * that spawned the flow. A server-side OAuth redirect has no spawning window, so
 * it cannot satisfy that requirement by construction — and it also cannot carry
 * the `extras` object, which is documented only as an `FB.login()` option.
 *
 * ── WHAT THIS MEANS FOR THE CONSOLE ─────────────────────────────────────────
 * `https://connect.facebook.net/en_US/sdk.js` executes with full access to this
 * origin. There is no Content-Security-Policy anywhere in this repository, so
 * nothing constrains it; adding one is deliberately not part of this change,
 * but the exposure is real and is written down in docs/threat-model.md.
 *
 * The blast radius is kept as small as it can be without a CSP: the script is
 * loaded **lazily**, only when an operator actually clicks Connect, and only on
 * the one page that needs it — never as part of the base bundle, and never on a
 * page that renders message content or keys. If it fails to load for any reason
 * (blocked, offline, an extension), the caller falls back to the server-side
 * redirect, which needs no third-party script at all.
 */

/** The sliver of the SDK surface this console uses. */
export interface FacebookSdk {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    // Deliberately `object` rather than an index signature: the options are
    // built by `loginOptions()` in embedded-signup.ts, which is where their
    // exact v4 shape is pinned and tested.
    options: object,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
/** Long enough for a cold CDN fetch, short enough that a blocked script does not
 * look like a hung button. */
const SDK_LOAD_TIMEOUT_MS = 8_000;

let loading: Promise<FacebookSdk> | null = null;

/**
 * Load and initialise the SDK once per page, resolving with the initialised
 * global. Rejects when the script cannot load or does not initialise in time —
 * the caller is expected to fall back rather than to surface an error, because
 * a working alternative path exists.
 */
export function loadFacebookSdk(appId: string, graphVersion: string): Promise<FacebookSdk> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("the Facebook SDK needs a browser"));
  }
  if (window.FB) return Promise.resolve(window.FB);
  if (loading) return loading;

  loading = new Promise<FacebookSdk>((resolve, reject) => {
    const timer = setTimeout(() => {
      loading = null;
      reject(new Error("the Facebook SDK did not load"));
    }, SDK_LOAD_TIMEOUT_MS);

    const settle = () => {
      const sdk = window.FB;
      if (!sdk) return;
      clearTimeout(timer);
      // `autoLogAppEvents` is Meta's documented default for this flow; `xfbml`
      // parses their social plugins, of which this page renders none, but the
      // sample sets it and deviating buys nothing.
      sdk.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion });
      resolve(sdk);
    };

    // The SDK calls `fbAsyncInit` when it is ready; the `onload` handler covers
    // the case where it was already present and the callback never fires.
    window.fbAsyncInit = settle;
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", settle, { once: true });
      if (window.FB) settle();
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", () => {
      clearTimeout(timer);
      loading = null;
      reject(new Error("the Facebook SDK could not be loaded"));
    });
    document.head.appendChild(script);
  });
  return loading;
}
