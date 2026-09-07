import { useMemo, useState } from "react";
import { Link, createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import { EventSheet } from "../components/logs/event-sheet";
import { HeldNotice } from "../components/logs/held-notice";
import { LogPager } from "../components/logs/log-pager";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { FailureView } from "../components/dashboard/failure";
import { listInbound, retryDelivery } from "../server/gateway";
import type { InboundRow } from "../server/gateway";
import { forwardReading } from "../lib/forwarding";
import {
  EMPTY_CELL,
  eventCountEntries,
  eventReading,
  messageRefText,
  messageSummary,
  wamidTail,
} from "../lib/logs";
import { normalizeSearchRowId, normalizeSearchStatus, normalizeSearchWabaId } from "../lib/search";
import { COUNT_LINK, Page, StatusTag, fmtTs } from "../ui";
import { cn } from "@/lib/utils";

/**
 * ── EVENTS ──────────────────────────────────────────────────────────────────
 * Every normalised callback Meta sent, and what Eccos did with each one.
 *
 * This is the old /inbound, and the rename is the bug fix. `inbound_events`
 * holds EVERY callback: `delivered` and `read` are Meta reporting on messages
 * WE sent, `failed` is one of our sends refused, and only `reply` and `echo`
 * are a human writing. A page called "Inbound" showing two `delivered` rows
 * said two customers had written in, on a workspace where nobody had.
 *
 * So the count row spells the split out — `2 events · replies 0 · echoes 0 ·
 * delivered 2` — and the KIND column says the event's own word with no
 * translation. Families are told apart by INK WEIGHT, not colour: a page of
 * status callbacks with one reply in it should let the reply stand out without
 * spending a semantic colour on ordinary traffic (data rule 1).
 *
 * The FORWARD column is the second hop, in the forward vocabulary
 * (`lib/forwarding.ts`), and it is where `held` finally has a word.
 */

const PAGE_SIZE = 50;

/**
 * The forward filter, in the console's words on the left and the database's on
 * the right. `waiting` covers all three readings of `pending` — held, queued
 * and retrying — because they are one row state and the filter follows the
 * data, not the label.
 */
const FORWARD_FILTERS: Record<string, string> = {
  waiting: "pending",
  forwarded: "delivered",
  failed: "failed",
};

type EventsSearch = {
  kind?: string;
  forward?: string;
  before?: number;
  event?: number;
  wabaId?: string;
};

export const Route = createFileRoute("/events")({
  validateSearch: (search: Record<string, unknown>): EventsSearch => {
    const forward = normalizeSearchStatus(search.forward);
    return {
      kind: normalizeSearchStatus(search.kind),
      // An unknown word is dropped rather than passed on: the wire carries
      // database vocabulary, and a filter the console cannot name has no
      // translation to send.
      forward: forward && forward in FORWARD_FILTERS ? forward : undefined,
      before: normalizeSearchRowId(search.before),
      event: normalizeSearchRowId(search.event),
      wabaId: normalizeSearchWabaId(search.wabaId),
    };
  },
  // `event` stays out of the deps for the same reason `message` does on
  // /messages: opening a sheet reads a row the page already has.
  loaderDeps: ({ search }) => ({
    kind: search.kind,
    forward: search.forward,
    before: search.before,
    wabaId: search.wabaId,
  }),
  loader: ({ deps }) =>
    listInbound({
      data: {
        wabaId: deps.wabaId,
        type: deps.kind,
        deliveryStatus: deps.forward ? FORWARD_FILTERS[deps.forward] : undefined,
        before: deps.before,
      },
    }),
  component: EventsPage,
  pendingComponent: () => <GridPending title="Events" kicker="Logs" columns={eventColumns()} />,
});

const columnHelper = createColumnHelper<DataGridFeatures, InboundRow>();

/** Ink weight per family — the whole visual system of the KIND column. */
const FAMILY_INK: Record<string, string> = {
  message: "text-foreground",
  status: "text-muted-foreground",
  problem: "text-destructive-foreground",
};

/**
 * KIND — the event's own word, and the row's door into its sheet.
 *
 * The door has to be a real control (interaction contrast): `LogGrid` puts
 * `onRowClick` on a bare `<tr>` with no role and no tab stop, so without this
 * the sheet would be reachable only by a pointer that guessed. The row click
 * stays as the wide target over it.
 */
function kindColumn(onOpen?: (row: InboundRow) => void) {
  return columnHelper.accessor("type", {
    id: "type",
    header: "Kind",
    cell: (info) => {
      const row = info.row.original;
      const family = eventReading(row.type, row.payload).family;
      const ink = FAMILY_INK[family] ?? "text-muted-foreground";
      if (!onOpen) return <span className={ink}>{row.type}</span>;
      return (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(row);
          }}
          aria-label={`Inspect event ${row.id}`}
          className={cn(ink, COUNT_LINK, "hover:text-primary")}
        >
          {row.type}
        </button>
      );
    },
    meta: { cellClassName: "whitespace-nowrap" },
  });
}

/**
 * PARTY — who the event concerns.
 *
 * Three answers, and the third is the one that did not exist. A reply carries
 * `from` and an echo carries `to`, both real phone numbers. A status callback
 * carries neither: it is about one of OUR messages, so the cell points at that
 * message — the join the console never made, even though the wamid was printed
 * in full on both logs. When no message matches the wamid (sent outside Eccos,
 * or aged out) the tail of the wamid is shown instead, muted, because a
 * dead-end id is still better than a blank.
 *
 * The column this replaces was `Phone ID`: the workspace's own number, the same
 * value on every row of every page.
 */
function partyColumn(wabaId?: string) {
  return columnHelper.display({
    id: "party",
    header: "Party",
    cell: (info) => {
      const row = info.row.original;
      const reading = eventReading(row.type, row.payload);
      if (reading.party) {
        return (
          <span className="whitespace-nowrap">
            <span className="text-muted-foreground">{reading.party.direction} </span>
            <span className="font-mono text-xs">+{reading.party.phone}</span>
          </span>
        );
      }
      if (row.outbound_id != null) {
        const summary = messageSummary(row.outbound_id, row.outbound_request ?? "");
        return (
          <Link
            to="/messages"
            search={{ message: row.outbound_id, ...(wabaId ? { wabaId } : {}) }}
            // Stops here: this link goes to the MESSAGE sheet on another page,
            // while the row underneath opens this event's own sheet.
            onClick={(event) => event.stopPropagation()}
            className={cn("font-mono text-xs text-foreground hover:text-primary", COUNT_LINK)}
          >
            ↳ {messageRefText(summary)}
          </Link>
        );
      }
      if (row.transport_message_id) {
        return (
          <span
            className="font-mono text-muted-foreground text-xs"
            title={row.transport_message_id}
          >
            {wamidTail(row.transport_message_id)}
          </span>
        );
      }
      return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
    },
    meta: { cellClassName: "whitespace-nowrap" },
  });
}

/**
 * DETAIL — the row's content, and never a wamid.
 *
 * The column it replaces was headed "Summary" and fell back to
 * `transportMessageId` whenever an event had no text — which is every status
 * callback, i.e. most rows on most workspaces. Sixty characters of base64 under
 * a header promising a summary.
 *
 * Clamped to two lines: a long reply is a paragraph, and one row of a log is
 * not where it gets read. The sheet holds the whole of it.
 */
const detailColumn = columnHelper.accessor("payload", {
  id: "detail",
  header: "Detail",
  cell: (info) => {
    const row = info.row.original;
    const reading = eventReading(row.type, row.payload);
    if (!reading.detail) return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
    return (
      <span
        className={cn(
          "line-clamp-2",
          reading.family === "problem" ? "text-destructive-foreground" : "text-foreground/80",
        )}
        title={reading.detail}
      >
        {reading.detail}
      </span>
    );
  },
  meta: { cellClassName: "max-w-md break-words" },
});

function forwardColumn(hasForwardingTarget: boolean) {
  return columnHelper.accessor("delivery_status", {
    id: "forward",
    header: "Forward",
    cell: (info) => {
      const row = info.row.original;
      const reading = forwardReading({
        status: row.delivery_status,
        attempts: row.delivery_attempts,
        hasForwardingTarget,
      });
      if (!reading) return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
      return <StatusTag status={reading.label} />;
    },
    meta: { cellClassName: "whitespace-nowrap" },
  });
}

const phoneColumn = columnHelper.accessor("phone_number_id", {
  id: "phone_number_id",
  header: "Phone",
  cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? EMPTY_CELL}</span>,
  meta: { cellClassName: "text-foreground/80 break-all" },
});

/** Module-level for the pending view; PHONE appears only on a WABA with more
 * than one number (see the same note on /messages). */
function eventColumns(options?: {
  onOpen?: (row: InboundRow) => void;
  hasForwardingTarget?: boolean;
  wabaId?: string;
  showPhone?: boolean;
}) {
  return [
    columnHelper.accessor("received_at", {
      id: "received_at",
      header: "Received",
      cell: (info) => <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>,
      meta: { cellClassName: "align-top whitespace-nowrap" },
    }),
    kindColumn(options?.onOpen),
    partyColumn(options?.wabaId),
    detailColumn,
    forwardColumn(options?.hasForwardingTarget ?? false),
    ...(options?.showPhone ?? true ? [phoneColumn] : []),
  ];
}

function EventsPage() {
  const result = Route.useLoaderData();
  const { kind, forward, before, event, wabaId } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [retrying, setRetrying] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const rows = useMemo(() => (result.ok ? result.data : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Events" kicker="Logs">
        <FailureView failure={result} />
      </Page>
    );
  }

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const phones =
    ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const hasForwardingTarget = root.ok ? root.hasForwardingTarget : false;
  const counts = ready?.status.counts;
  const pending = counts?.deliveries.pending ?? 0;

  const openEvent = (row: InboundRow) =>
    navigate({ search: (prev) => ({ ...prev, event: row.id }) });

  async function onRetry(deliveryId: number) {
    setRetrying(deliveryId);
    setRetryError(null);
    try {
      const retry = await retryDelivery({
        data: { id: deliveryId, wabaId: selectedWabaId ?? "" },
      });
      if (!retry.ok) {
        setRetryError(retry.error);
        return;
      }
      await router.invalidate();
    } catch (error) {
      // A THROW, not a `{ ok: false }`: the server function's own validator and
      // the network are the two things that raise here, and without this the
      // spinner would reset with nothing said and the rejection would go
      // unhandled. Data rule 7 — name what is known, which is the message.
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(null);
    }
  }

  // Data rule 5: Retry exists only on a batch that actually failed. A waiting
  // batch is already queued (or held, which retrying would not release), and a
  // forwarded one would DUPLICATE into the customer's system.
  const actionColumn = columnHelper.display({
    id: "action",
    header: () => <span className="sr-only">Actions</span>,
    cell: (info) => {
      const row = info.row.original;
      if (row.delivery_status !== "failed" || row.delivery_id == null) {
        return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
      }
      const deliveryId = row.delivery_id;
      return (
        // Covers only itself: a shield across this cell would swallow every row
        // click landing in the column's slack.
        // biome-ignore lint/a11y/useKeyWithClickEvents: not a control — a shield over one, with no role and no tab stop.
        <span className="inline-flex" onClick={(clicked) => clicked.stopPropagation()}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none"
            aria-label={`Retry batch ${deliveryId}`}
            disabled={retrying === deliveryId}
            onClick={() => onRetry(deliveryId)}
          >
            {retrying === deliveryId ? "…" : "Retry"}
          </Button>
        </span>
      );
    },
    meta: {
      headerClassName: "text-right",
      cellClassName: "text-right whitespace-nowrap",
    },
  });

  const columns = [
    ...eventColumns({
      onOpen: openEvent,
      hasForwardingTarget,
      wabaId: selectedWabaId,
      showPhone: phones.length > 1,
    }),
    actionColumn,
  ];

  const oldestId = rows.at(-1)?.id;
  const canLoadOlder = rows.length === PAGE_SIZE && oldestId !== undefined;
  const isNarrowed = kind !== undefined || forward !== undefined || before !== undefined;
  const activeForward = forward ?? "all";

  // The row the URL addresses, if it is on this page. `null` is a real answer —
  // a pasted link to an older event — and the sheet says so rather than opening
  // onto nothing.
  const addressed = rows.find((row) => row.id === event) ?? null;
  const retryableBatch =
    addressed?.delivery_status === "failed" ? addressed.delivery_id ?? null : null;

  const filterControl = (
    <>
      <label className="sr-only" htmlFor="event-forward-filter">
        Filter events by forwarding state
      </label>
      <Select
        value={activeForward}
        onValueChange={(value) =>
          navigate({
            search: (prev) => ({
              ...prev,
              forward: !value || value === "all" ? undefined : value,
              before: undefined,
            }),
          })
        }
      >
        <SelectTrigger id="event-forward-filter" size="sm" className="w-36">
          <SelectValue>
            {(value: string | null) => (value === "all" ? "all forwards" : value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="all">all forwards</SelectItem>
          {Object.keys(FORWARD_FILTERS).map((value) => (
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
      description="No events match this view."
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
      label="NO EVENTS YET"
      description="Replies from customers and Meta's status callbacks about your sends will appear here."
    />
  );

  return (
    <Page title="Events" kicker="Logs" actions={filterControl}>
      <EventCounts
        byType={counts?.inboundByType ?? {}}
        total={counts?.inbound ?? 0}
        activeKind={kind}
        wabaId={selectedWabaId}
      />
      {/* Always mounted, and silent unless it has something to say — the
          component owns that decision so the queue and the event log cannot
          disagree about when forwarding is held. */}
      <HeldNotice
        pending={pending}
        hasForwardingTarget={hasForwardingTarget}
        wabaId={selectedWabaId}
      />
      {retryError ? (
        <p
          className="mb-4 border-l-2 border-destructive px-3 py-2 text-destructive-foreground text-sm"
          role="alert"
        >
          {retryError}
        </p>
      ) : null}
      <LogGrid
        columns={columns}
        data={rows}
        emptyMessage={emptyState}
        getRowId={(row) => String(row.id)}
        onRowClick={openEvent}
      />
      <LogPager
        canLoadOlder={canLoadOlder}
        hasCursor={before !== undefined}
        onLatest={() => navigate({ search: (prev) => ({ ...prev, before: undefined }) })}
        onOlder={() =>
          oldestId !== undefined && navigate({ search: (prev) => ({ ...prev, before: oldestId }) })
        }
      />
      {event !== undefined ? (
        <EventSheet
          // Remounted per row, so one event's payload never renders over
          // another's.
          key={`event:${event}`}
          open
          onOpenChange={(open) => {
            if (!open) navigate({ search: (prev) => ({ ...prev, event: undefined }) });
          }}
          row={addressed}
          hasForwardingTarget={hasForwardingTarget}
          wabaId={selectedWabaId}
          // Passed only when there is something to retry, so the sheet renders
          // no control at all otherwise (data rule 5).
          {...(retryableBatch == null
            ? {}
            : { onRetry: () => onRetry(retryableBatch), retrying: retrying === retryableBatch })}
        />
      ) : null}
    </Page>
  );
}

/**
 * The count row, and the sentence it exists to make unmisreadable.
 *
 * Ink follows family, not magnitude (`lib/logs.ts` decides which is which):
 * replies and echoes are what a human did and read at full strength; the status
 * kinds are traffic and stay muted; `failed` takes the one semantic colour on
 * the row. Every entry is a door into this page filtered to it — including the
 * total, which is the door back out of a filter.
 */
function EventCounts({
  byType,
  total,
  activeKind,
  wabaId,
}: {
  byType: Record<string, number>;
  total: number;
  activeKind?: string;
  wabaId?: string;
}) {
  const entries = eventCountEntries(byType);
  const search = wabaId ? { wabaId } : {};
  return (
    <ul
      aria-label="events by kind"
      className="mb-4 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 text-[11px] font-medium tracking-wider uppercase"
    >
      <li>
        <Link
          to="/events"
          search={search}
          className={cn(
            COUNT_LINK,
            activeKind === undefined ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="tabular-nums">{total}</span> {total === 1 ? "event" : "events"}
        </Link>
      </li>
      {entries.map((entry) => (
        <li key={entry.kind} className="flex items-center gap-2">
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <Link
            to="/events"
            search={{ kind: entry.kind, ...search }}
            className={cn(
              COUNT_LINK,
              entry.family === "problem"
                ? "text-[#ff7777]"
                : entry.family === "message"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label} <span className="tabular-nums">{entry.n}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
