import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { type ListCheck, type RowCheck, type Slot, skippedCount, STATE_TAGS } from "../../lib/recipient-list";
import { COUNT_LINK, fmtCount, StatusTag } from "../../ui";
import { CELL, MACHINE_CLASS, ROW, SUPPORT_TIER } from "../dashboard/plain-table";

const PAGE = 50;
type View = "all" | "send" | "skipped";

/**
 * Every row of the list with its one state: problems wear a tag and their reason,
 * a good row the em-dash. Three views (all, will send, skipped), 50 rows a page,
 * and a click on a row shows its message in the preview.
 */
export function RecipientTable({
  slots,
  check,
  previewRow,
  onPreview,
  onDownload,
}: {
  slots: Slot[];
  check: ListCheck;
  /** The 1-based row in the preview. */
  previewRow: number | null;
  onPreview: (row: number) => void;
  onDownload: () => void;
}) {
  const [view, setView] = useState<View>("all");
  const [page, setPage] = useState(0);
  const skipped = skippedCount(check);
  const rows = check.rows.filter((row) => view === "all" || (view === "send") === (row.state === "send"));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const last = Math.max(0, Math.ceil(rows.length / PAGE) - 1);
  const views: { id: View; label: string; count: number; ink?: string }[] = [
    { id: "all", label: "All", count: check.rows.length },
    { id: "send", label: "Will send", count: check.counts.send },
    { id: "skipped", label: "Skipped", count: skipped, ink: skipped > 0 ? "text-warning-foreground" : undefined },
  ];

  return (
    <div className="flex flex-col gap-3">
      {skipped * 5 > check.rows.length ? (
        <Callout tone="warning">More than a fifth of this list will not be sent. Check the phone column and the country code.</Callout>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <fieldset className="m-0 flex gap-5 border-0 p-0">
          <legend className="sr-only">Rows by state</legend>
          {views.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={view === entry.id}
              onClick={() => {
                setView(entry.id);
                setPage(0);
              }}
              className={`cursor-pointer border-b-2 pb-1.5 ${MACHINE_CLASS} ${
                view === entry.id ? "border-foreground text-foreground" : `border-transparent hover:text-foreground ${entry.ink ?? ""}`
              }`}
            >
              {entry.label} <span className="tabular-nums">{fmtCount(entry.count)}</span>
            </button>
          ))}
        </fieldset>
        {skipped > 0 ? (
          <button type="button" onClick={onDownload} className={`text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground`}>
            Download the {fmtCount(skipped)} skipped {skipped === 1 ? "row" : "rows"} (CSV)
          </button>
        ) : null}
      </div>

      <div className="overflow-x-auto border border-(--line)">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted">
            <tr className="border-b border-(--line)">
              <th className={`${CELL} w-14 font-medium ${MACHINE_CLASS}`}>Row</th>
              <th className={`${CELL} font-medium ${MACHINE_CLASS}`}>To</th>
              {slots.map((slot) => (
                <th key={slot.id} className={`${CELL} font-mono text-[11px] font-normal text-muted-foreground`}>
                  {slot.label}
                </th>
              ))}
              <th className={`${CELL} font-medium ${MACHINE_CLASS}`}>Check</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <RecipientRow key={row.row} row={row} previewed={row.row === previewRow} onPreview={onPreview} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className={`m-0 ${SUPPORT_TIER}`}>
          {rows.length === 0
            ? "No rows in this view."
            : `Rows ${fmtCount(page * PAGE + 1)}–${fmtCount(page * PAGE + shown.length)} of ${fmtCount(rows.length)}. Click a row to see its message.`}
        </p>
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="icon-sm" aria-label="Previous rows" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Next rows" disabled={page >= last} onClick={() => setPage(page + 1)}>
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecipientRow({ row, previewed, onPreview }: { row: RowCheck; previewed: boolean; onPreview: (row: number) => void }) {
  const skipped = row.state !== "send";
  return (
    // The row is a wide target over the row number's button, which is the keyboard's way in.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <tr
      className={`${ROW} cursor-pointer ${previewed ? "bg-(--tint-live) shadow-[inset_2px_0_0_var(--mark)]" : ""}`}
      onClick={() => onPreview(row.row)}
    >
      <td className={`${CELL} font-mono text-xs text-muted-foreground`}>
        <button type="button" className={COUNT_LINK} aria-label={`Preview row ${row.row}`} onClick={() => onPreview(row.row)}>
          {row.row}
        </button>
      </td>
      <td
        className={`${CELL} font-mono text-xs whitespace-nowrap ${row.state === "invalid" ? "text-destructive-foreground" : skipped ? "text-muted-foreground" : "text-foreground"}`}
        title={row.detail ?? undefined}
      >
        {row.to || "—"}
      </td>
      {row.values.map((value, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one cell per slot, in slot order
        <td key={i} className={`${CELL} ${skipped ? "text-muted-foreground" : "text-foreground"}`}>
          {value || <span className="text-warning-foreground italic">empty</span>}
        </td>
      ))}
      <td className={`${CELL} whitespace-nowrap`}>
        {row.state === "send" ? (
          previewed ? (
            <span className="text-xs text-ink">In the preview</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        ) : (
          <span className="inline-flex items-center gap-2">
            <StatusTag status={STATE_TAGS[row.state]} />
            {row.reason ? <span className="text-xs text-muted-foreground">{row.reason}</span> : null}
          </span>
        )}
      </td>
    </tr>
  );
}
