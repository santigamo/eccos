import { useState } from "react";
import { Button } from "@/components/ui/button";
import { recheckNumber } from "../../server/gateway";
import type { AccountResources } from "../../server/gateway";
import { StatusTag } from "../../ui";

type Notice = { ok: boolean; text: string };

type NumberRow = {
  key: string;
  displayPhoneNumber: string;
  phoneNumberId: string;
  wabaId: string;
  status: string;
};

/**
 * One row per phone number, the unit an operator actually thinks in; the WABA
 * it belongs to is the secondary column. Rail-separated rows on the shared
 * grid, per the console's data rules.
 *
 * A row is normally `active` by the time this page loads: the Embedded Signup
 * callback provisions before it hands the operator back (eccos-lpk). The
 * `pending` case is the tail of that, and it is handled here rather than left as
 * a bare tag: the table says what pending means and the row carries the one
 * action that can change it.
 */
export function NumbersTable({
  resources,
  onRefresh,
}: {
  resources: AccountResources;
  /** Re-read the loader once a re-check changed something. The route owns it. */
  onRefresh?: () => void | Promise<void>;
}) {
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const rows: NumberRow[] = resources.wabas.flatMap((waba) =>
    waba.phones.map((phone) => ({
      key: `${waba.wabaId}:${phone.phoneNumberId}`,
      displayPhoneNumber: phone.displayPhoneNumber,
      phoneNumberId: phone.phoneNumberId,
      wabaId: waba.wabaId,
      status: waba.status,
    })),
  );
  const pendingRows = rows.filter((row) => row.status === "pending").length;

  async function onRecheck(wabaId: string) {
    setRechecking(wabaId);
    setNotice(null);
    try {
      const result = await recheckNumber({ data: { wabaId } });
      if (!result.ok) {
        setNotice({ ok: false, text: result.error });
        return;
      }
      if (!result.data.ok) {
        setNotice({ ok: false, text: result.data.error });
        return;
      }
      if (result.data.status === "active") {
        // The row turning green is the answer; a banner would only repeat it.
        await onRefresh?.();
        return;
      }
      setNotice({
        ok: false,
        text:
          result.data.error ??
          "Meta has not confirmed the subscription yet. Eccos will keep retrying.",
      });
      await onRefresh?.();
    } finally {
      setRechecking(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-(--line)">
              <Th>Number</Th>
              <Th>Phone number ID</Th>
              <Th>WABA</Th>
              <Th>Status</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-(--line) transition-colors hover:bg-white/[.03]">
                <td className="px-3 py-2.5 font-mono text-xs text-foreground">
                  {row.displayPhoneNumber || "—"}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                  {row.phoneNumberId}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                  {row.wabaId}
                </td>
                <td className="px-3 py-2.5">
                  <StatusTag status={row.status} />
                </td>
                <td className="px-3 py-2.5">
                  <RowAction
                    row={row}
                    running={rechecking === row.wabaId}
                    disabled={rechecking !== null}
                    onRecheck={onRecheck}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pendingRows > 0 ? <PendingNote count={pendingRows} /> : null}

      {/* Mounted even when empty: a live region that appears with its message is
          not reliably announced, one that fills up is. */}
      <output
        aria-live="polite"
        aria-atomic="true"
        className={
          notice
            ? "block border-l-2 border-l-[#e03131] px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground"
            : undefined
        }
      >
        {notice?.text}
      </output>
    </div>
  );
}

/**
 * Re-check only exists where it can change something: a number Meta has not
 * confirmed yet, or one whose provisioning gave up. An active row holds the
 * column's rhythm with a muted em-dash instead of a dead button.
 */
function RowAction({
  row,
  running,
  disabled,
  onRecheck,
}: {
  row: NumberRow;
  running: boolean;
  disabled: boolean;
  onRecheck: (wabaId: string) => void;
}) {
  if (row.status !== "pending" && row.status !== "failed") {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="rounded-none"
      aria-label={`Re-check ${row.displayPhoneNumber || row.phoneNumberId}`}
      aria-busy={running}
      disabled={disabled}
      onClick={() => onRecheck(row.wabaId)}
    >
      {running ? "…" : "Re-check"}
    </Button>
  );
}

/**
 * What `pending` means, in the console's own words. Structure, not a coloured
 * banner: waiting is not a failure, and the amber tag already carries the state.
 */
function PendingNote({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-(--line) pt-3">
      <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        Waiting on Meta
      </p>
      <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
        {count === 1
          ? "This number is registered, but Eccos has not finished subscribing it to its Meta webhooks. It keeps retrying on its own. Re-check runs that now."
          : `${count} numbers are registered, but Eccos has not finished subscribing them to their Meta webhooks. It keeps retrying on its own. Re-check runs that now.`}
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
      {children}
    </th>
  );
}
