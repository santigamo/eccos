import type { ColumnDef } from "@tanstack/react-table"

import { LogGrid } from "@/components/grid/log-grid"
import type { DataGridFeatures } from "@/components/reui/data-grid/data-grid"
import { Page } from "@/ui"

/**
 * What a log route renders while its loader is in flight — its own header band
 * over its own column headers, with the rows still to come.
 *
 * WHY A ROUTE NEEDS THIS AT ALL. TanStack keeps the PREVIOUS match mounted
 * until the next one resolves, so without a `pendingComponent` a slow
 * navigation leaves the operator reading the wrong page's rows under the
 * correct page's sidebar highlight. `RouteProgress` answers the click; this
 * answers the wait.
 *
 * It carries the real title, kicker and column headers rather than a generic
 * shimmer, because those are the parts of the destination that are already
 * known — the page announces itself, and only the rows are pending.
 *
 * Timing is the router's (`src/router.tsx`): this appears only once a load has
 * run past `defaultPendingMs`, so a fast navigation never flashes it.
 */
export function GridPending<TData extends object>({
  title,
  kicker,
  columns,
}: {
  title: string
  kicker: string
  // biome-ignore lint/suspicious/noExplicitAny: matches LogGrid's own column type.
  columns: ColumnDef<DataGridFeatures, TData, any>[]
}) {
  return (
    <Page title={title} kicker={kicker}>
      <LogGrid columns={columns} data={[]} isLoading />
    </Page>
  )
}
