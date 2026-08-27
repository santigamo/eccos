import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { GridEmptyState } from "../components/grid/empty-state";
import { LogGrid } from "../components/grid/log-grid";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { listInbound } from "../server/gateway";
import type { InboundRow } from "../server/gateway";
import { Page, Unreachable, fmtTs } from "../ui";

export const Route = createFileRoute("/inbound")({
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => listInbound({ data: { wabaId: deps.wabaId } }),
  component: InboundPage,
});

function inboundSummary(payload: string): string {
  try {
    const ev = JSON.parse(payload) as Record<string, unknown>;
    if (typeof ev.text === "string") return ev.text;
    if (typeof ev.transportMessageId === "string") return ev.transportMessageId;
    return JSON.stringify(ev).slice(0, 140);
  } catch {
    return payload.slice(0, 140);
  }
}

const columnHelper = createColumnHelper<DataGridFeatures, InboundRow>();

const columns = [
  columnHelper.accessor("received_at", {
    id: "received_at",
    header: "Received",
    cell: (info) => (
      <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>
    ),
    meta: { cellClassName: "align-top whitespace-nowrap" },
  }),
  columnHelper.accessor("type", {
    id: "type",
    header: "Type",
    cell: (info) => info.getValue(),
    meta: { cellClassName: "whitespace-nowrap" },
  }),
  columnHelper.accessor("phone_number_id", {
    id: "phone_number_id",
    header: "Phone ID",
    cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? "\u2014"}</span>,
    meta: { cellClassName: "text-foreground/80 break-all" },
  }),
  columnHelper.accessor("payload", {
    id: "summary",
    header: "Summary",
    cell: (info) => inboundSummary(info.getValue()),
    meta: { cellClassName: "text-foreground/80 break-words" },
  }),
];

function InboundPage() {
  const result = Route.useLoaderData();
  const rows = useMemo(() => (result.ok ? result.data : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Inbound" kicker="Logs">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  return (
    <Page title="Inbound" kicker="Logs">
      <LogGrid
        columns={columns}
        data={rows}
        emptyMessage={
          <GridEmptyState
            label="NO INBOUND EVENTS YET"
            description="Messages and statuses received from Meta will appear here."
          />
        }
        getRowId={(row) => String(row.id)}
      />
    </Page>
  );
}
