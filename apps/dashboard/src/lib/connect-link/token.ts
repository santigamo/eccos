const STORAGE_KEY = "eccos.connect-link";

/**
 * The link token, read from the URL fragment and then taken out of the address
 * bar: Meta's SDK copies the page URL into its popup, and a fragment left in
 * place would hand the token over. Session storage keeps it for a reload.
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
