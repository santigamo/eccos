import { useMemo } from "react";
import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import { LogPager } from "../components/logs/log-pager";
import { MessageSheet } from "../components/logs/message-sheet";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { FailureView } from "../components/dashboard/failure";
import { listOutbound } from "../server/gateway";
import type { OutboundRow, OutboundTrailEvent } from "../server/gateway";
import { normalizeSearchRowId, normalizeSearchStatus, normalizeSearchWabaId } from "../lib/search";
import { EMPTY_CELL, messageSummary, messageSummaryText } from "../lib/logs";
import { COUNT_LINK, Page, StatusCounts, StatusTag, fmtTs } from "../ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * ── MESSAGES ────────────────────────────────────────────────────────────────
 * What Eccos sent, and what came back about it.
 *
 * This is the old /outbound, renamed for what it holds. The rename is not
 * cosmetic: the log beside it was called "Inbound" and held every callback —
 * including the `delivered` receipts for the rows on THIS page — so the two
 * names described the same happening twice and neither said which hop it meant.
 *
 * The unit is the MESSAGE. One send is one row, and everything Meta later said
 * about it hangs off that row as its TRAIL instead of appearing as separate
 * events in a second log. Two template sends used to produce nine rows across
 * three pages; they now produce two rows here and two events next door.
 *
 * The vocabulary is fixed and narrow: this page speaks Eccos → Meta (`sent` /
 * `failed`) in the META column and Meta → phone (`delivered` / `read` /
 * `failed`) in TRAIL. It never says a forward state — that hop belongs to the
 * events and to the queue.
 */

const PAGE_SIZE = 50;
/** What Meta can answer. Listed rather than derived so the filter offers both
 * words on a workspace that has only ever seen one of them. */
const META_STATUSES = ["sent", "failed"] as const;

type MessagesSearch = { status?: string; before?: number; message?: number; wabaId?: string };

export const Route = createFileRoute("/messages")({
  validateSearch: (search: Record<string, unknown>): MessagesSearch => ({
    status: normalizeSearchStatus(search.status),
    before: normalizeSearchRowId(search.before),
    message: normalizeSearchRowId(search.message),
    wabaId: normalizeSearchWabaId(search.wabaId),
  }),
  // `message` is deliberately NOT a loader dep: opening the inspection sheet
  // reads a row the page already has, so addressing one must not re-run the
  // loader and re-paint the list underneath it.
  loaderDeps: ({ search }) => ({
    status: search.status,
    before: search.before,
    wabaId: search.wabaId,
  }),
  loader: ({ deps }) => listOutbound({ data: deps }),
  component: MessagesPage,
  pendingComponent: () => (
    <GridPending title="Messages" kicker="Logs" columns={messageColumns()} />
  ),
});

const columnHelper = createColumnHelper<DataGridFeatures, OutboundRow>();

/**
 * The MESSAGE cell — the row's door into its own sheet.
 *
 * The console's existing door anatomy (`COUNT_LINK`), same as the template name
 * on /templates and for the same reason: `LogGrid` hangs `onRowClick` off a
 * bare `<tr>` with no role and no tab stop, so a row-only affordance is
 * unreachable by keyboard and invisible until a pointer guesses. The row click
 * is the wide target over a control that already exists.
 *
 * WHAT IT SAYS is the point. The column it replaces printed the wamid — sixty
 * characters of base64 that identify the message at Meta and nowhere else. This
 * reads `#1042 · template cita_encontrada · es`: the id an operator can quote,
 * the kind, and the template. The wamid still exists, in full, inside the
 * sheet, where there is room for it.
 *
 * `onOpen` is optional because the same column draws the pending view's header,
 * where there is no row to open.
 */
function messageColumn(onOpen?: (row: OutboundRow) => void) {
  return columnHelper.accessor("request", {
    id: "message",
    header: "Message",
    cell: (info) => {
      const row = info.row.original;
      const label = messageSummaryText(messageSummary(row.id, row.request));
      if (!onOpen) return <span className="font-mono text-xs">{label}</span>;
      return (
        <button
          type="button"
          // Stops here: the row handles the same click, and letting it through
          // would open the sheet twice.
          onClick={(event) => {
            event.stopPropagation();
            onOpen(row);
          }}
          aria-label={`Inspect message ${row.id}`}
          className={`font-mono text-xs text-foreground ${COUNT_LINK} hover:text-primary`}
        >
          {label}
        </button>
      );
    },
    meta: { cellClassName: "whitespace-nowrap" },
  });
}

/**
 * TRAIL — what Meta reported back, oldest first.
 *
 * `—` on a refused send is a FACT, not a gap: without a wamid there is nothing
 * a status callback can be about, so the column is empty by construction rather
 * than by delay. The trail's own `failed` takes red; `delivered` and `read` are
 * ordinary progress and stay muted (data rule 1).
 */
const trailColumn = columnHelper.accessor("trail", {
  id: "trail",
  header: "Trail",
  cell: (info) => {
    const trail = info.getValue() ?? [];
    if (trail.length === 0) return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
    return (
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {trail.map((event: OutboundTrailEvent, index: number) => (
          <span key={event.type} className="flex items-center gap-1.5">
            {index > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
            ) : null}
            <span
              className={
                event.type === "failed" ? "text-destructive-foreground" : "text-muted-foreground"
              }
              title={fmtTs(event.at)}
            >
              {event.type}
              {event.errorCode ? ` ${event.errorCode}` : ""}
            </span>
          </span>
        ))}
      </span>
    );
  },
  meta: { cellClassName: "whitespace-nowrap" },
});

const phoneColumn = columnHelper.accessor("phone_number_id", {
  id: "phone_number_id",
  header: "Phone",
  cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? EMPTY_CELL}</span>,
  meta: { cellClassName: "text-foreground/80 break-all" },
});

/**
 * Module-level so the route's `pendingComponent` can draw the real headers
 * while the loader runs.
 *
 * PHONE IS A COLUMN THAT DISAPPEARS, not one that was deleted. On a
 * single-number WABA it repeats the same id on every row — the workspace's own
 * `phone_number_id`, which is not information about the message. On a WABA with
 * two numbers it is the first thing an operator needs. Column visibility, so
 * both accounts get the table they need; the pending view shows it because it
 * cannot know yet.
 */
function messageColumns(onOpen?: (row: OutboundRow) => void, showPhone = true) {
  return [
    columnHelper.accessor("created_at", {
      id: "created_at",
      header: "Created",
      cell: (info) => <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>,
      meta: { cellClassName: "align-top whitespace-nowrap" },
    }),
    columnHelper.accessor("recipient", {
      id: "recipient",
      header: "To",
      cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    messageColumn(onOpen),
    columnHelper.accessor("status", {
      id: "status",
      header: "Meta",
      cell: (info) => <StatusTag status={info.getValue()} />,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    trailColumn,
    columnHelper.accessor("error", {
      id: "error",
      header: "Error",
      cell: (info) => info.getValue() ?? EMPTY_CELL,
      meta: { cellClassName: "text-foreground/80 break-words" },
    }),
    ...(showPhone ? [phoneColumn] : []),
  ];
}

function MessagesPage() {
  const result = Route.useLoaderData();
  const { status, before, message, wabaId } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const navigate = Route.useNavigate();
  const rows = useMemo(() => (result.ok ? result.data : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Messages" kicker="Logs">
        <FailureView failure={result} />
      </Page>
    );
  }

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const phones =
    ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const counts = ready?.status.counts.outbound ?? {};
  const hasForwardingTarget = root.ok ? root.hasForwardingTarget : false;

  const openMessage = (row: OutboundRow) =>
    navigate({ search: (prev) => ({ ...prev, message: row.id }) });
  const closeMessage = () => navigate({ search: (prev) => ({ ...prev, message: undefined }) });

  const columns = messageColumns(openMessage, phones.length > 1);
  const activeStatus = status ?? "all";
  const statuses = Array.from(
    new Set<string>([...META_STATUSES, ...rows.map((row) => row.status), ...(status ? [status] : [])]),
  ).sort();

  const oldestId = rows.at(-1)?.id;
  const canLoadOlder = rows.length === PAGE_SIZE && oldestId !== undefined;
  const isNarrowed = status !== undefined || before !== undefined;

  const filterControl = (
    <>
      <label className="sr-only" htmlFor="message-status-filter">
        Filter messages by what Meta answered
      </label>
      {/* The fixed width and the label-rendering `SelectValue` are the house
          idiom from the forwarding queue — see the comments there for why each
          exists. */}
      <Select
        value={activeStatus}
        onValueChange={(value) =>
          navigate({
            search: (prev) => ({
              ...prev,
              status: !value || value === "all" ? undefined : value,
              before: undefined,
            }),
          })
        }
      >
        <SelectTrigger id="message-status-filter" size="sm" className="w-36">
          <SelectValue>
            {(value: string | null) => (value === "all" ? "all messages" : value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="all">all messages</SelectItem>
          {statuses.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );

  const emptyState = isNarrowed ? (
    <GridEmptyState
      label="NO MATCHES"
      description="No messages match this view."
      action={
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-sm"
          onClick={() => navigate({ search: () => (wabaId ? { wabaId } : {}) })}
        >
          Clear filters
        </Button>
      }
    />
  ) : (
    <GridEmptyState
      label="NO MESSAGES YET"
      description="Messages sent through the gateway API or the Send test sheet will appear here."
    />
  );

  return (
    <Page title="Messages" kicker="Logs" actions={filterControl}>
      {/* Data rule 3's count row, above the evidence it counts. Every entry is
          a door into this same page, filtered — the counts and the rows can
          never disagree because they are the same list. */}
      <StatusCounts label="messages" counts={counts} target="messages" wabaId={selectedWabaId} />
      <div className="mt-4">
        <LogGrid
          columns={columns}
          data={rows}
          emptyMessage={emptyState}
          getRowId={(row) => String(row.id)}
          onRowClick={openMessage}
        />
      </div>
      <LogPager
        canLoadOlder={canLoadOlder}
        hasCursor={before !== undefined}
        onLatest={() => navigate({ search: (prev) => ({ ...prev, before: undefined }) })}
        onOlder={() =>
          oldestId !== undefined && navigate({ search: (prev) => ({ ...prev, before: oldestId }) })
        }
      />
      {message !== undefined ? (
        <MessageSheet
          // Remounted per row, so one message's trail never renders over
          // another's.
          key={`message:${message}`}
          open
          onOpenChange={(open) => {
            if (!open) closeMessage();
          }}
          row={rows.find((row) => row.id === message) ?? null}
          hasForwardingTarget={hasForwardingTarget}
          wabaId={selectedWabaId}
        />
      ) : null}
    </Page>
  );
}
