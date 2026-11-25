/**
 * Keeps React alive under in-browser page translation (Chrome/Google Translate).
 *
 * The translator swaps React's text nodes for its own `<font>` wrappers, so a
 * later commit asks the parent to remove or insert next to a node it no longer
 * holds and the whole tree throws NotFoundError (react#11538; Sentry
 * ECCOS-DASHBOARD-B on /numbers). The console is English-only, so translated
 * sessions are expected. A node that has already left the parent is a no-op
 * instead of a crash.
 */
export function installTranslateGuard(): void {
  if (typeof Node !== "function" || !Node.prototype) return;

  const removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child) as T;
  };

  const insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) return node;
    return insertBefore.call(this, node, ref) as T;
  };
}
