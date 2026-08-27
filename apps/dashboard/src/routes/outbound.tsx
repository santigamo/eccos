import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { GridEmptyState } from "../components/grid/empty-state";
import { LogGrid } from "../components/grid/log-grid";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { listOutbound } from "../server/gateway";
import type { OutboundRow } from "../server/gateway";
import { Page, StatusTag, Unreachable, fmtTs } from "../ui";

export const Route = createFileRoute("/outbound")({
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => listOutbound({ data: { wabaId: deps.wabaId } }),
  component: OutboundPage,
});

const columnHelper = createColumnHelper<DataGridFeatures, OutboundRow>();

const columns = [
  columnHelper.accessor("created_at", {
    id: "created_at",
    header: "Created",
    cell: (info) => (
      <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>
    ),
    meta: { cellClassName: "align-top whitespace-nowrap" },
  }),
  columnHelper.accessor("recipient", {
    id: "recipient",
    header: "Recipient",
    cell: (info) => info.getValue(),
    meta: { cellClassName: "whitespace-nowrap" },
  }),
  columnHelper.accessor("phone_number_id", {
    id: "phone_number_id",
    header: "Phone ID",
    cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? "\u2014"}</span>,
    meta: { cellClassName: "text-foreground/80 break-all" },
  }),
  columnHelper.accessor("status", {
    id: "status",
    header: "Status",
    cell: (info) => <StatusTag status={info.getValue()} />,
    meta: { cellClassName: "whitespace-nowrap" },
  }),
  columnHelper.accessor("transport_message_id", {
    id: "transport_message_id",
    header: "Transport ID",
    cell: (info) => (
      <span className="font-mono text-xs">{info.getValue() ?? "\u2014"}</span>
    ),
    meta: { cellClassName: "text-foreground/80 break-all" },
  }),
  columnHelper.accessor("error", {
    id: "error",
    header: "Error",
    cell: (info) => info.getValue() ?? "\u2014",
    meta: { cellClassName: "text-foreground/80 break-words" },
  }),
];

function OutboundPage() {
  const result = Route.useLoaderData();
  const rows = useMemo(() => (result.ok ? result.data : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Outbound" kicker="Logs">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  return (
    <Page title="Outbound" kicker="Logs">
      <LogGrid
        columns={columns}
        data={rows}
        emptyMessage={
          <GridEmptyState
            label="NO OUTBOUND MESSAGES YET"
            description="Messages sent through the gateway API will appear here."
          />
        }
        getRowId={(row) => String(row.id)}
      />
    </Page>
  );
}
