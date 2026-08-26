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
  emptyMessage?: string
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
          "font-pixel text-[11px] tracking-wider uppercase",
        headerRow: "bg-muted/40",
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
      <DataGridScrollArea
        className="w-full min-h-0 max-h-[calc(100svh-var(--header-height,3rem))]"
        orientation="vertical"
      >
        <DataGridContainer>
          <DataGridTable footerContent={footer} />
        </DataGridContainer>
      </DataGridScrollArea>
    </DataGrid>
  )
}
