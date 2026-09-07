import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import { createColumnHelper } from "@tanstack/react-table";
import type { DataGridFeatures } from "../src/components/reui/data-grid/data-grid";

/**
 * The two things that answer a navigation click before the page does
 * (eccos-msz): the progress rail in `components/dashboard/route-progress.tsx`,
 * and the per-route pending view in `components/grid/grid-pending.tsx`.
 *
 * THE DEFECT THEY EXIST FOR. TanStack points `state.location` at the
 * DESTINATION the instant a link is pressed, so the sidebar repaints its
 * active item immediately — while the previous match stays mounted until the
 * new loader resolves. With nothing in between, the sidebar claims the
 * operator arrived and the content disagrees, and every gateway round trip
 * reads as a dead click.
 *
 * WHAT A STATIC RENDER CAN REACH. `renderToStaticMarkup` gives one frame with
 * no DOM and no timers, so the rail's `isLoading` transition is not testable
 * here — what is pinned is its resting shape (present, dark, out of the way,
 * announced to assistive tech) and the fact that the pending view carries the
 * destination's own title, kicker and column headers rather than a generic
 * shimmer. The router timings that decide WHEN the pending view appears live
 * in `src/router.tsx` and are asserted there.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

let isLoading = false;

// SPREAD, not replaced. `mock.module` swaps the module for the whole test
// process, so a partial stub here breaks the NEXT file that imports a router
// export this one happened not to need (`useLoaderData`, and the suite fails
// somewhere else entirely). Only the one hook under test is overridden.
const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  useRouterState: ({ select }: { select: (state: { isLoading: boolean }) => unknown }) =>
    select({ isLoading }),
}));

const { RouteProgress } = await import("../src/components/dashboard/route-progress");
const { GridPending } = await import("../src/components/grid/grid-pending");

describe("RouteProgress", () => {
  test("rests invisible and costs the page no layout", () => {
    isLoading = false;
    const html = renderToStaticMarkup(<RouteProgress />);
    // Fixed and aria-hidden: the rail is decoration over the masthead, never a
    // band that pushes the page down when a navigation starts.
    expect(html).toContain('class="route-progress"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-loading="true"');
  });

  test("a route change is announced, not only drawn", () => {
    // A navigation swaps the whole main region with no focus move, so without
    // a live region a screen reader gets no notice that anything happened.
    isLoading = true;
    const html = renderToStaticMarkup(<RouteProgress />);
    // `<output>` carries an implicit role="status".
    expect(html).toContain("<output");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading page");
    isLoading = false;
  });

  test("says nothing while nothing is loading", () => {
    isLoading = false;
    expect(renderToStaticMarkup(<RouteProgress />)).not.toContain("Loading page");
  });
});

interface Row {
  id: number;
  label: string;
}

const helper = createColumnHelper<DataGridFeatures, Row>();
const columns = [
  helper.accessor("id", { id: "id", header: "ID" }),
  helper.accessor("label", { id: "label", header: "Label" }),
];

describe("GridPending", () => {
  test("the destination announces itself: its own title, kicker and headers", () => {
    // The point of a per-route pending view over a generic spinner. Everything
    // except the rows is already known at navigation time, so the operator
    // reads the page they asked for while its data is still in flight —
    // instead of the previous page's rows under the new sidebar highlight.
    const html = renderToStaticMarkup(
      <GridPending title="Deliveries" kicker="Logs" columns={columns} />,
    );
    expect(html).toContain("Deliveries");
    expect(html).toContain("Logs");
    expect(html).toContain(">ID</th>");
    expect(html).toContain(">Label</th>");
  });

  test("the rows are skeletons, not blank cells", () => {
    // The vendored grid reads its skeleton out of `meta.skeleton`, which no
    // column here declares — LogGrid fills that in, or the pending view would
    // paint ten EMPTY rows: structure with nothing in it, which reads as a
    // broken table rather than a loading one.
    const html = renderToStaticMarkup(
      <GridPending title="Deliveries" kicker="Logs" columns={columns} />,
    );
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain("animate-pulse");
  });

  test("no empty state while loading — nothing is known to be absent yet", () => {
    const html = renderToStaticMarkup(
      <GridPending title="Inbound" kicker="Logs" columns={columns} />,
    );
    expect(html).not.toContain("NO INBOUND");
  });
});
