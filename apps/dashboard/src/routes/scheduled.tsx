import { useMemo, useState } from "react";
import { toast } from "sonner";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { MetaErrorCell } from "../components/broadcasts/meta-error-cell";
import { FailureView } from "../components/dashboard/failure";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import { LogPager } from "../components/logs/log-pager";
import { normalizeSearchTrail, type PageTrail } from "../lib/page-trail";
import { RefreshControls } from "../components/logs/refresh-controls";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { CancelScheduledDialog } from "../components/scheduled/cancel-scheduled-dialog";
import { ScheduleSendSheet } from "../components/scheduled/schedule-send-sheet";
import { ScheduledExample } from "../components/scheduled/scheduled-example";
import { ScheduledStatusTabs } from "../components/scheduled/scheduled-status-tabs";
import { SendAtCell } from "../components/scheduled/send-at-cell";
import { FirstRun } from "../components/sending/first-run";
import { Callout } from "../components/ui/callout";
import { useLiveRefresh } from "../hooks/use-live-refresh";
import { scheduledCurl, tomorrowAtNine } from "../lib/curl";
import { loaderFailure } from "../lib/failure";
import { invalidatePage } from "../lib/invalidate";
import { EMPTY_CELL, wamidTail } from "../lib/logs";
import { rootRole } from "../lib/root-role";
import { LIVE_STALE_MS } from "../lib/route-stale";
import {
  SCHEDULED_EMPTY,
  normalizeScheduledStatus,
  normalizeScheduleKey,
  readsSoonestFirst,
  scheduledFirstRun,
  scheduledOutcome,
} from "../lib/scheduled";
import { shortWhen } from "../lib/schedule-draft";
import { normalizeSearchWabaId } from "../lib/search";
import { rootSendsPaused } from "../lib/sends-paused";
import { gatewayOriginOrNull, listScheduled } from "../server/gateway";
import type { ScheduledSend, ScheduledStatus } from "../server/gateway";
import { Page, fmtCount, fmtTs } from "../ui";

/**
 * ── SCHEDULED ───────────────────────────────────────────────────────────────
 * One approved template to one recipient at a set time, under the client's key.
 * One status at a time: pending reads soonest first, the ended ones newest first.
 * Outcomes speak the Eccos → Meta hop.
 */

type ScheduledSearch = { wabaId?: string; status?: ScheduledStatus; cursor?: string; trail?: PageTrail };

const TITLE = "Scheduled sends";
const GUIDE = { href: "https://docs.eccos.chat/scheduled-sends", label: "Scheduled sends guide" };

export const Route = createFileRoute("/scheduled")({
  staleTime: LIVE_STALE_MS,
  validateSearch: (search: Record<string, unknown>): ScheduledSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    status: normalizeScheduledStatus(search.status),
    cursor: normalizeScheduleKey(search.cursor),
    trail: normalizeSearchTrail(search.trail, search.cursor),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId, status: search.status, cursor: search.cursor }),
  loader: async ({ deps }) => {
    const list = await listScheduled({ data: deps }).catch(loaderFailure);
    // The origin only fills the first-run block's request.
    const firstRun = list.ok && scheduledFirstRun(list.data.counts);
    const origin = firstRun ? await gatewayOriginOrNull() : null;
    return { list, origin };
  },
  component: ScheduledPage,
  pendingComponent: () => <GridPending title={TITLE} kicker="Sending" columns={scheduledColumns()} />,
});

const columnHelper = createColumnHelper<DataGridFeatures, ScheduledSend>();

function scheduledColumns(opts: { showPhone?: boolean; onCancel?: (row: ScheduledSend) => void } = {}) {
  return [
    columnHelper.accessor("sendAt", {
      id: "send_at",
      header: "Send at",
      cell: (info) => <SendAtCell row={info.row.original} />,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("key", {
      id: "key",
      header: "Key",
      cell: (info) => (
        <span
          className="font-mono text-xs break-all"
          title={`created ${fmtTs(info.row.original.createdAt)} · updated ${fmtTs(info.row.original.updatedAt)}`}
        >
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("to", {
      id: "to",
      header: "To",
      cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("template", {
      id: "template",
      header: "Template",
      cell: (info) => (
        <>
          {info.getValue().name}
          <span className="text-muted-foreground"> · {info.getValue().language}</span>
        </>
      ),
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    columnHelper.accessor("attempts", {
      id: "attempts",
      header: "Attempts",
      cell: (info) =>
        info.getValue() === 0 ? (
          <span className="text-muted-foreground">{EMPTY_CELL}</span>
        ) : (
          <span className="font-mono text-xs tabular-nums">{info.getValue()}</span>
        ),
      meta: { headerClassName: "text-right", cellClassName: "text-right whitespace-nowrap" },
    }),
    columnHelper.display({
      id: "outcome",
      header: "Outcome",
      cell: (info) => {
        const outcome = scheduledOutcome(info.row.original);
        if (!outcome) return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
        switch (outcome.kind) {
          case "message":
            return (
              <span className="font-mono text-xs" title={outcome.messageId}>
                {wamidTail(outcome.messageId)}
              </span>
            );
          case "expired":
            return <span className="text-muted-foreground">expired</span>;
          case "error":
            return <MetaErrorCell raw={outcome.raw} />;
          case "unknown":
            return "unknown outcome";
        }
      },
      meta: { cellClassName: "text-foreground/80" },
    }),
    ...(opts.showPhone
      ? [
          columnHelper.accessor("phoneNumberId", {
            id: "phone_number_id",
            header: "Phone",
            cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
            meta: { cellClassName: "text-foreground/80 break-all" },
          }),
        ]
      : []),
    ...(opts.onCancel
      ? [
          columnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            cell: (info) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  opts.onCancel?.(info.row.original);
                }}
              >
                Cancel
              </Button>
            ),
            meta: { headerClassName: "text-right", cellClassName: "text-right whitespace-nowrap" },
          }),
        ]
      : []),
  ];
}

function ScheduledPage() {
  const { list: result, origin } = Route.useLoaderData();
  const { wabaId, status = "pending", cursor, trail } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const router = useRouter();
  const navigate = Route.useNavigate();
  const liveRefresh = useLiveRefresh("scheduled");
  const refreshControls = <RefreshControls {...liveRefresh} />;
  const [cancelling, setCancelling] = useState<ScheduledSend | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const rows = useMemo(() => (result.ok ? result.data.items : []), [result]);

  if (!result.ok) {
    return (
      <Page title={TITLE} kicker="Sending" actions={refreshControls}>
        <FailureView failure={result} />
      </Page>
    );
  }

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const selectedWabaId = wabaId ?? ready?.scope.selectedWabaId;
  const phones =
    ready?.scope.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const { counts, nextCursor } = result.data;
  const canSchedule = Boolean(rootRole(root)?.canOperate && selectedWabaId && phones.length > 0);
  const scheduleSheet =
    scheduling && selectedWabaId ? (
      <ScheduleSendSheet
        wabaId={selectedWabaId}
        phones={phones}
        onOpenChange={setScheduling}
        onScheduled={(scheduled) => {
          setScheduling(false);
          toast(`Scheduled for ${shortWhen(scheduled.sendAt)}`);
          // The new row is pending: show that tab from its first page, or re-read the one on screen.
          if (status !== "pending" || cursor !== undefined) navigate({ search: () => (wabaId ? { wabaId } : {}) });
          else void invalidatePage(router);
        }}
        onStale={() => void invalidatePage(router)}
      />
    ) : null;

  if (scheduledFirstRun(counts)) {
    const path = "…/scheduled/appt-8812";
    return (
      <Page title={TITLE} kicker="Sending" actions={refreshControls}>
        <FirstRun
          label="No scheduled sends yet"
          title="Send a template at a time you choose"
          lede="One approved template to one person at a set time: an appointment reminder, a renewal notice, a follow-up. Your booking system schedules it, moves it and cancels it; Eccos sends it on time."
          action={
            canSchedule ? (
              <>
                <Button type="button" onClick={() => setScheduling(true)}>
                  Schedule a send
                </Button>
                <span className="text-sm text-muted-foreground">
                  No booking system? Schedule one by hand: one template, one person, one time.
                </span>
              </>
            ) : undefined
          }
          door={{
            sentence: "One request per reminder, under your own id.",
            requests: [
              { method: "PUT", path, note: "schedule" },
              { method: "PUT", path, note: "move" },
              { method: "DELETE", path, note: "cancel" },
            ],
            curl: scheduledCurl(selectedWabaId, origin, tomorrowAtNine(new Date())),
            guide: GUIDE,
            canCreateKey: rootRole(root)?.canAdminister ?? false,
          }}
          fullRequestLabel="The full request · schedule one send"
          example={<ScheduledExample />}
          footnote="Every send is scheduled one by one, up to 90 days ahead. Nothing repeats on its own."
        />
        {scheduleSheet}
      </Page>
    );
  }

  const empty = SCHEDULED_EMPTY[status];
  const emptyState =
    cursor !== undefined ? (
      <GridEmptyState
        label="NO MATCHES"
        description="No scheduled sends are left on this page."
        action={
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-sm"
            onClick={() => navigate({ search: (prev) => ({ ...prev, cursor: undefined }) })}
          >
            ← back to the first page
          </Button>
        }
      />
    ) : (
      <GridEmptyState
        label={empty.label}
        description={empty.description}
        action={
          status === "pending" ? undefined : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-sm"
              onClick={() => navigate({ search: () => (wabaId ? { wabaId } : {}) })}
            >
              Show pending
            </Button>
          )
        }
      />
    );

  return (
    <Page
      title={TITLE}
      kicker="Sending"
      actions={
        <>
          {refreshControls}
          {canSchedule ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setScheduling(true)}>
              Schedule a send
            </Button>
          ) : null}
        </>
      }
      intro={
        <>
          One template to one person at a set time, under a key from your system. A pending send goes out at its
          time, or expires.{" "}
          <a href={GUIDE.href} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
            {GUIDE.label} ↗
          </a>
        </>
      }
    >
      {rootSendsPaused(root) && counts.pending > 0 ? (
        <Callout tone="warning" className="mb-4">
          Sending is paused for this workspace. The {fmtCount(counts.pending)} pending{" "}
          {counts.pending === 1 ? "send waits" : "sends wait"}, and each one that has not gone out by its expiry is not
          sent.
        </Callout>
      ) : null}
      <ScheduledStatusTabs counts={counts} status={status} wabaId={wabaId} />
      <LogGrid
        key={cursor ?? "first"}
        columns={scheduledColumns({
          showPhone: phones.length > 1,
          onCancel: status === "pending" ? setCancelling : undefined,
        })}
        data={rows}
        emptyMessage={emptyState}
        getRowId={(row) => row.key}
      />
      <LogPager
        param="cursor"
        cursor={cursor}
        trail={trail}
        nextCursor={nextCursor}
        firstLabel={readsSoonestFirst(status) ? "Soonest" : undefined}
      />
      {cancelling && selectedWabaId ? (
        <CancelScheduledDialog
          wabaId={selectedWabaId}
          scheduled={cancelling}
          onOpenChange={(open) => !open && setCancelling(null)}
          onCancelled={() => invalidatePage(router)}
        />
      ) : null}
      {scheduleSheet}
    </Page>
  );
}
