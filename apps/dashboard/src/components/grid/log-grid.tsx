import { useMemo, type ReactNode } from "react"
import { useTable } from "@tanstack/react-table"
import type { ColumnDef } from "@tanstack/react-table"

import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
  type DataGridFeatures,
} from "@/components/reui/data-grid/data-grid"
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area"
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table"
import { Skeleton } from "@/components/ui/skeleton"

export function LogGrid<TData extends object>({
  columns,
  data,
  emptyMessage,
  footer,
  getRowId,
  isLoading = false,
  onRowClick,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: TanStack v9 keeps ColumnDef TValue invariant across accessor columns.
  columns: ColumnDef<DataGridFeatures, TData, any>[]
  data: TData[]
  // ReactNode, not just string: routes pass a structured <GridEmptyState />
  // block. The data grid renders it inside its own full-width `<td colSpan>`
  // (header row still visible above), and its provider already keeps unstable
  // inline-ReactNode prop identities out of the context value.
  emptyMessage?: ReactNode
  footer?: ReactNode
  getRowId?: (row: TData, index: number) => string
  /** Render the pending skeleton instead of rows — what a route's
   *  `pendingComponent` mounts while its loader is in flight. */
  isLoading?: boolean
  /** Opens the row's own surface. The grid puts this on the `<tr>`, which has
   *  no keyboard path of its own, so a caller that uses it owes the row a
   *  focusable control as well — see the name cell on /templates. */
  onRowClick?: (row: TData) => void
}) {
  // The vendored grid reads its skeleton cell out of `meta.skeleton`, which is
  // opt-in per column — so a grid that never declared one paints ten EMPTY
  // rows while it loads: structure with nothing in it, which reads as a broken
  // table rather than a loading one. Filling the gap here rather than at every
  // column keeps each log view's pending state honest by default.
  //
  // The test is the KEY, not the value, so a column can opt out with an
  // explicit `skeleton: null` — which a spacer column carrying no data wants,
  // and which `skeleton ? …` would have quietly overridden.
  const skeletonColumns = useMemo(
    () =>
      columns.map((column) =>
        column.meta && "skeleton" in column.meta
          ? column
          : {
              ...column,
              meta: { ...column.meta, skeleton: <Skeleton className="h-3 w-24" /> },
            },
      ),
    [columns],
  )

  const table = useTable({
    features: dataGridFeatures,
    columns: skeletonColumns,
    data,
    manualPagination: true,
    ...(getRowId ? { getRowId } : {}),
  })

  return (
    <DataGrid
      table={table}
      recordCount={data.length}
      className="w-full"
      tableClassNames={{
        header:
          "text-[11px] font-medium tracking-wider uppercase",
        // Solid: the sticky header floats over rows scrolling beneath it, and
        // the container is now translucent glass — a tinted header would let
        // them bleed through.
        headerRow: "bg-muted",
        // Quiet row hover — visible on the dark ground, never a highlight.
        // Last in the row's cn(), so it wins over the default hover:bg-muted/40.
        bodyRow: "hover:bg-white/[.03]",
      }}
      tableLayout={{
        dense: true,
        rowRounded: false,
        cellBorder: false,
        rowBorder: true,
        stripped: false,
        headerBackground: true,
        headerBorder: true,
        headerSticky: true,
        width: "auto",
      }}
      emptyMessage={emptyMessage}
      isLoading={isLoading}
      loadingMode="skeleton"
      onRowClick={onRowClick}
    >
      {/*
        The panel edge lives here, not on DataGridContainer: that component's
        `border` prop is a no-op, and a border inside the scroll viewport would
        scroll away with the rows. On the scroll root the frame stays put while
        the body scrolls under the sticky header, and `bg-card` gives the table
        the same panel ground the routes used to inherit from the page frame.
        The max-height also leaves room for the page header band, so the grid
        scrolls inside its own panel instead of pushing the page into a second
        scrollbar.
      */}
      <DataGridScrollArea
        className="w-full min-h-0 max-h-[calc(100svh-var(--header-height,3rem)-10rem)] border border-border bg-card"
        orientation="vertical"
      >
        <DataGridContainer>
          <DataGridTable footerContent={footer} />
        </DataGridContainer>
      </DataGridScrollArea>
    </DataGrid>
  )
}
