import type { ReactNode } from "react"
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

export function LogGrid<TData extends object>({
  columns,
  data,
  emptyMessage,
  footer,
  getRowId,
  isLoading = false,
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
  isLoading?: boolean
}) {
  const table = useTable({
    features: dataGridFeatures,
    columns,
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
          "font-pixel text-xs tracking-wider uppercase",
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
