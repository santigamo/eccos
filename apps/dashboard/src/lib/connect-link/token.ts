const STORAGE_KEY = "eccos.connect-link";

/**
 * The link token, read from the URL fragment and then taken out of the address
 * bar: Meta's SDK copies the page URL into its popup, and a fragment left in
 * place would hand the token over. Session storage keeps it for a reload; a
 * fragment always wins over what was stored, and replaces it.
 */
export function takeLinkToken(win: Window = window): string | null {
  const fromHash = win.location.hash.slice(1);
  // First, and on its own: storage that throws must not leave the token in the address bar.
  if (fromHash) win.history.replaceState(win.history.state, "", win.location.pathname + win.location.search);
  try {
    if (fromHash) win.sessionStorage.setItem(STORAGE_KEY, fromHash);
    return fromHash || win.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return fromHash || null;
  }
}

/** Drops the stored token once it has answered "gone", so a reload does not present it again. */
export function forgetLinkToken(win: Window = window): void {
  try {
    win.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
