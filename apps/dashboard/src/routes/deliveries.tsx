import { useMemo, useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
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
import { HeldNotice } from "../components/logs/held-notice";
import { LogPager } from "../components/logs/log-pager";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { FailureView } from "../components/dashboard/failure";
import { listDeliveries, retryDelivery } from "../server/gateway";
import type { DeliveryRecord } from "../server/gateway";
import {
  FORWARD_MAX_ATTEMPTS,
  batchEventSummary,
  deliveryMoment,
  forwardReading,
} from "../lib/forwarding";
import { EMPTY_CELL } from "../lib/logs";
import { normalizeSearchBefore, normalizeSearchStatus, normalizeSearchWabaId } from "../lib/search";
import { Page, StatusTag, fmtTs } from "../ui";

/**
 * ── THE FORWARDING QUEUE ────────────────────────────────────────────────────
 * One row per BATCH Eccos posts to the subscriber. Unlisted, and deliberately.
 *
 * The forward is a STATE on an event, not a happening of its own, so it is
 * shown as a column on /events and does not earn a third sidebar entry beside
 * Messages and Events. What earns this page is the one act that is genuinely
 * batch-shaped — Retry re-enqueues a batch, not an event — and every
 * `StatusCounts` link in the console already points here. So the route stays,
 * off the sidebar, the way `/numbers/attach-token` does.
 *
 * The three columns added here are the ones that make a row readable at all:
 * ENQUEUED (a row's age was previously unreadable — `created_at` was never
 * shown), EVENTS (what the batch is actually carrying) and WHEN, which NAMES
 * which moment its timestamp is. The old header said "Next attempt" over every
 * row alike, so a held batch showed a next attempt in the past for work that
 * was never going to be attempted: a lie by label, on the exact row an operator
 * opens this page to understand.
 */

const PAGE_SIZE = 50;
const KNOWN_STATUSES = ["pending", "delivered", "failed"] as const;

/**
 * The filter's words. The VALUES stay the database's, because every
 * `StatusCounts` link in the console addresses this page with them
 * (`/deliveries?status=failed`) and those links are the console's evidence
 * trail. Only the label translates.
 *
 * `waiting` rather than three separate options: held, queued and retrying are
 * one row state (`pending`) read three ways, and a filter that offered them
 * separately would promise a narrowing the data cannot do.
 */
const STATUS_LABELS: Record<string, string> = {
  pending: "waiting",
  delivered: "forwarded",
  failed: "failed",
};

type DeliveriesSearch = { status?: string; before?: number; wabaId?: string };

export const Route = createFileRoute("/deliveries")({
  validateSearch: (search: Record<string, unknown>): DeliveriesSearch => {
    const status = normalizeSearchStatus(search.status);
    const before = normalizeSearchBefore(search.before);
    const wabaId = normalizeSearchWabaId(search.wabaId);
    return { status, before, wabaId };
  },
  loaderDeps: ({ search }) => ({ status: search.status, before: search.before, wabaId: search.wabaId }),
  loader: ({ deps }) =>
    listDeliveries({ data: { status: deps.status, before: deps.before, wabaId: deps.wabaId } }),
  component: DeliveriesPage,
  // Past `defaultPendingMs` the previous page's rows are replaced by this
  // page's structure, instead of lingering under the new sidebar highlight.
  pendingComponent: () => (
    <GridPending title="Forwarding queue" kicker="Logs" columns={deliveryColumns(false)} />
  ),
});

const columnHelper = createColumnHelper<DataGridFeatures, DeliveryRecord>();

/**
 * The columns that describe a batch. A function rather than a constant because
 * two of them read `hasForwardingTarget` — the difference between `held` and
 * `queued`, and between "next attempt" and no next attempt at all — and the
 * pending view has not loaded it yet, so it draws the `false` shape: headers
 * only, which is all a pending view renders.
 *
 * The Retry column stays out and lives in the component, which closes over the
 * in-flight retry state; there is nothing to retry on a page that has not
 * loaded.
 */
function deliveryColumns(hasForwardingTarget: boolean, showPhone = false) {
  return [
    columnHelper.accessor("id", {
      id: "id",
      header: "Batch",
      cell: (info) => (
        <span className="font-mono text-xs tabular-nums">#{info.getValue()}</span>
      ),
      meta: {
        headerClassName: "text-right",
        cellClassName: "text-right whitespace-nowrap",
      },
    }),
    // The moment the batch ARRIVED. Absent until now, which meant a row's age
    // could not be read at all — and age is the first question about a queue.
    columnHelper.accessor("created_at", {
      id: "created_at",
      header: "Enqueued",
      cell: (info) => <span className="font-mono text-xs">{fmtTs(info.getValue())}</span>,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    // WHAT IS IN IT. A queue whose rows say only "failed" cannot tell an
    // operator whether the thing that failed mattered; `1 reply` and
    // `2 delivered · 1 read` are different levels of urgency entirely.
    columnHelper.accessor("payload", {
      id: "events",
      header: "Events",
      cell: (info) => {
        const summary = batchEventSummary(info.getValue());
        return (
          <span className={summary === "content expired" ? "text-muted-foreground" : undefined}>
            {summary}
          </span>
        );
      },
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("status", {
      id: "status",
      header: "State",
      cell: (info) => {
        const row = info.row.original;
        const reading = forwardReading({
          status: row.status,
          attempts: row.attempts,
          hasForwardingTarget,
        });
        return reading ? <StatusTag status={reading.label} /> : <span>{EMPTY_CELL}</span>;
      },
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    // `2 / 6`, never a bare `2`: the count only means anything against the
    // ceiling. `0 / 6` on a held row then reads as "nothing spent", which is
    // exactly what it is.
    columnHelper.accessor("attempts", {
      id: "attempts",
      header: "Attempts",
      cell: (info) => (
        <span className="font-mono text-xs tabular-nums">
          {info.getValue()} / {FORWARD_MAX_ATTEMPTS}
        </span>
      ),
      meta: {
        headerClassName: "text-right",
        cellClassName: "text-right whitespace-nowrap",
      },
    }),
    columnHelper.accessor("next_attempt_at", {
      id: "when",
      header: "When",
      cell: (info) => {
        const moment = deliveryMoment(info.row.original, hasForwardingTarget);
        if (moment.at === null) {
          // `held` is the whole answer and takes no time: nothing is scheduled,
          // and inventing one would be the bug this column replaced.
          return <span className="text-muted-foreground">{MOMENT_WORD[moment.label]}</span>;
        }
        return (
          <span className="whitespace-nowrap">
            <span className="text-muted-foreground">{MOMENT_WORD[moment.label]} </span>
            <span className="font-mono text-xs">{fmtTs(moment.at)}</span>
          </span>
        );
      },
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("last_error", {
      id: "last_error",
      header: "Last error",
      cell: (info) => info.getValue() ?? EMPTY_CELL,
      meta: { cellClassName: "text-foreground/80 break-words" },
    }),
    ...(showPhone
      ? [
          columnHelper.accessor("phone_number_id", {
            id: "phone_number_id",
            header: "Phone",
            cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? EMPTY_CELL}</span>,
            meta: { cellClassName: "text-foreground/80 break-all" },
          }),
        ]
      : []),
  ];
}

/** The word that names which moment the timestamp is. `unknown` renders the
 * em-dash: the row finished and the console does not know when (a batch written
 * before `finished_at` existed), which is not the same as having no moment. */
const MOMENT_WORD: Record<"finished" | "next" | "held" | "unknown", string> = {
  finished: "finished",
  next: "next",
  held: "held",
  unknown: EMPTY_CELL,
};

function DeliveriesPage() {
  const result = Route.useLoaderData();
  const { status, before, wabaId } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [retrying, setRetrying] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const rows = useMemo(() => (result.ok ? result.data : []), [result]);

  if (!result.ok) {
    return (
      <Page title="Forwarding queue" kicker="Logs">
        <FailureView failure={result} />
      </Page>
    );
  }

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const phones =
    ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const hasForwardingTarget = root.ok ? root.hasForwardingTarget : false;
  const pending = ready?.status.counts.deliveries.pending ?? 0;

  const activeStatus = status ?? "all";
  const statuses = Array.from(
    new Set<string>([
      ...KNOWN_STATUSES,
      ...rows.map((d) => d.status),
      ...(status ? [status] : []),
    ]),
  ).sort();

  const oldestId = rows.at(-1)?.id;
  const canLoadOlder = rows.length === PAGE_SIZE && oldestId !== undefined;

  async function onRetry(id: number) {
    setRetrying(id);
    setRetryError(null);
    try {
      const retry = await retryDelivery({ data: { id, wabaId: selectedWabaId ?? "" } });
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

  const deliveriesColumns = [
    ...deliveryColumns(hasForwardingTarget, phones.length > 1),
    columnHelper.display({
      id: "action",
      header: "Action",
      cell: (info) => {
        const record = info.row.original;
        // Retry is only meaningful on a FAILED batch. A waiting one is already
        // queued — or held, which retrying does not release; only naming a
        // receiver does. A forwarded one is done, and although `retryDelivery`
        // would happily replay it, that replay lands a SECOND copy in the
        // customer's system: the console must not offer a duplicate-maker as a
        // one-click row action. Every other row holds the column's rhythm with
        // a muted em-dash instead of a dead button.
        if (record.status !== "failed") {
          return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
        }
        return (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none"
            aria-label={`Retry batch ${record.id}`}
            disabled={retrying === record.id}
            onClick={() => onRetry(record.id)}
          >
            {retrying === record.id ? "…" : "Retry"}
          </Button>
        );
      },
    }),
  ];

  function onFilterChange(value: string) {
    navigate({
      search: (prev) => ({ ...prev, status: value === "all" ? undefined : value, before: undefined }),
    });
  }

  const filterControl = (
    <>
      <label className="sr-only" htmlFor="delivery-status-filter">
        Filter batches by forwarding state
      </label>
      <Select
        value={activeStatus}
        onValueChange={(value) => onFilterChange(value ?? "all")}
      >
        {/* A FIXED WIDTH, not `w-fit`: the trigger's own width would follow
            whatever is selected, so the one control in this page's header
            jumped and re-flowed every time it was used. 9rem holds the longest
            label with room to spare. */}
        <SelectTrigger id="delivery-status-filter" size="sm" className="w-36">
          {/* The trigger renders the ITEM'S LABEL, not the raw value. Without
              this it read `all` while the menu it opens says `all states` —
              two names for the same choice, and the shorter one is the one a
              sighted operator reads (the descriptive label is `sr-only`). */}
          <SelectValue>
            {(value: string | null) =>
              value === "all" ? "all states" : STATUS_LABELS[value ?? ""] ?? value
            }
          </SelectValue>
        </SelectTrigger>
        {/* `align="end"`: this control sits at the right edge of the page, so
            the popup has to grow inward.

            NO `min-w` OVERRIDE HERE, and that is the whole bug this replaced.
            The call site passed `min-w-(--anchor-width)`, which tailwind-merge
            reads as the same key as the component's `min-w-36` and drops it —
            leaving the popup pinned to `w-(--anchor-width)`, 55px, with every
            option clipped mid-word ("all statu…", "delivere…"). The component's
            floor is what makes the list readable; the anchor width was never
            adding anything, since `w-(--anchor-width)` already matches it. */}
        <SelectContent align="end">
          <SelectItem value="all">all states</SelectItem>
          {statuses.map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_LABELS[s] ?? s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );

  // A narrowed view that came back empty is a different message from a gateway
  // that has never forwarded anything: the first one has a way out.
  const isNarrowed = status !== undefined || before !== undefined;

  const emptyState = isNarrowed ? (
    <GridEmptyState
      label="NO MATCHES"
      description="No batches match this view."
      action={
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-sm"
          onClick={() => navigate({ search: () => ({ wabaId }) })}
        >
          Clear filters
        </Button>
      }
    />
  ) : (
    <GridEmptyState
      label="NO BATCHES YET"
      description="Forward attempts to your subscriber will appear here."
    />
  );

  return (
    <Page title="Forwarding queue" kicker="Logs" actions={filterControl}>
      {/* Always mounted, and silent unless it has something to say — the
          component owns that decision so the queue and the event log cannot
          disagree about when forwarding is held. */}
      <HeldNotice
        pending={pending}
        hasForwardingTarget={hasForwardingTarget}
        wabaId={selectedWabaId}
      />
      {retryError ? <p className="mb-4 border-l-2 border-destructive px-3 py-2 text-sm text-destructive-foreground" role="alert">{retryError}</p> : null}
      <LogGrid
        columns={deliveriesColumns}
        data={rows}
        emptyMessage={emptyState}
        getRowId={(row) => String(row.id)}
      />

      <LogPager
        canLoadOlder={canLoadOlder}
        hasCursor={before !== undefined}
        onLatest={() => navigate({ search: (prev) => ({ ...prev, before: undefined }) })}
        onOlder={() =>
          oldestId !== undefined && navigate({ search: (prev) => ({ ...prev, before: oldestId }) })
        }
      />
    </Page>
  );
}
