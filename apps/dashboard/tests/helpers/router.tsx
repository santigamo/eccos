import { mock } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Other test files replace @tanstack/react-router process-wide (mock.module cannot be undone),
// so a real RouterProvider here breaks depending on file order. Render without one instead:
// Link is an anchor and useRouter a stub, the same shape the other files use.
const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  Link: (props: { to: string; children: ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

/** Server-renders `ui` with router `Link`s as plain anchors. */
export async function renderInRouter(ui: ReactNode): Promise<string> {
  return renderToStaticMarkup(ui);
}
