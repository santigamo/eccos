import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";

/** Server-renders `ui` inside a throwaway router, so the router `Link`s in it render as anchors. */
export async function renderInRouter(ui: ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: true,
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}
