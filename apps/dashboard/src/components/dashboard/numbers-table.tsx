import { useState } from "react";
import { Button } from "@/components/ui/button";
import { recheckNumber } from "../../server/gateway";
import type { AccountResources } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import { StatusTag } from "../../ui";

type Notice = { ok: boolean; text: string };

type NumberRow = {
  key: string;
  displayPhoneNumber: string;
  phoneNumberId: string;
  wabaId: string;
  status: string;
  /** Coexistence sync state of the WABA this number belongs to (eccos-vss). */
  coexistence: string;
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
      coexistence: waba.coexistence.status,
    })),
  );
  const pendingRows = rows.filter((row) => row.status === "pending").length;
  const notCoexistenceRows = rows.filter((row) => row.coexistence === "not_coexistence").length;
  // A WABA with no numbers produces no rows at all, so without these it would be
  // connected and completely invisible here (Embedded Signup v4). Split by
  // status, because the two say opposite things to an operator: one resolves
  // itself and one does not.
  const phonelessWabas = resources.wabas.filter((waba) => waba.phones.length === 0);
  const awaitingPhoneWabas = phonelessWabas.filter((waba) => waba.status !== "failed");
  const failedPhonelessWabas = phonelessWabas.filter((waba) => waba.status === "failed");

  async function onRecheck(wabaId: string) {
    setRechecking(wabaId);
    setNotice(null);
    try {
      const result = await recheckNumber({ data: { wabaId } });
      if (!result.ok) {
        setNotice({ ok: false, text: failureCopy(result).detail });
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
      {awaitingPhoneWabas.length > 0 ? (
        <AwaitingPhoneNote
          wabas={awaitingPhoneWabas}
          rechecking={rechecking}
          disabled={rechecking !== null}
          onRecheck={onRecheck}
        />
      ) : null}
      {failedPhonelessWabas.length > 0 ? (
        <FailedPhonelessNote wabas={failedPhonelessWabas} />
      ) : null}
      {notCoexistenceRows > 0 ? <NotCoexistenceNote count={notCoexistenceRows} /> : null}

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

/**
 * A connected WhatsApp Business account with no number in it yet.
 *
 * Embedded Signup v4 lets a customer finish the flow having entered no phone
 * number, or one they never verified. The account is connected and its webhooks
 * are subscribed, but the table is built from phone numbers, so without this it
 * would show nothing at all and the operator would think the connection failed.
 * There is no action here for them: the number has to be added on the customer's
 * side, and Eccos picks it up by itself.
 */
function AwaitingPhoneNote({
  wabas,
  rechecking,
  disabled,
  onRecheck,
}: {
  wabas: AccountResources["wabas"];
  rechecking: string | null;
  disabled: boolean;
  onRecheck: (wabaId: string) => void;
}) {
  const count = wabas.length;
  return (
    <div className="flex flex-col gap-1.5 border-t border-(--line) pt-3">
      <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        Waiting on a phone number
      </p>
      <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
        {count === 1
          ? "One WhatsApp Business account is connected but has no business phone number yet. Add one in WhatsApp Manager and it will appear here on its own — nothing needs reconnecting."
          : `${count} WhatsApp Business accounts are connected but have no business phone number yet. Add one to each in WhatsApp Manager and they will appear here on their own — nothing needs reconnecting.`}{" "}
        Check now if you have just added one.
      </p>
      {/* "On its own" means the five-minute cron. An operator who has this
          second added the number in WhatsApp Manager should not have to sit
          through it: the same reconciler the row-level Re-check runs also
          adopts newly-appeared phones. Admin+, like every other reconcile. */}
      <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0 pt-1">
        {wabas.map((waba) => (
          <li key={waba.wabaId} className="flex items-center gap-2">
            {count > 1 ? (
              <span className="font-mono text-xs text-muted-foreground">{waba.wabaId}</span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-none"
              aria-label={`Check ${waba.wabaId} for a phone number now`}
              aria-busy={rechecking === waba.wabaId}
              disabled={disabled}
              onClick={() => onRecheck(waba.wabaId)}
            >
              {rechecking === waba.wabaId ? "…" : "Check now"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A WABA with no numbers whose provisioning actually failed — Meta refused the
 * subscription, say. It is the same invisible shape as the one above (no
 * numbers, so no rows) but the opposite situation: nothing is coming, and the
 * only account-level error message there is lives on the WABA record. Without
 * this the table would either show nothing at all or, worse, tell the operator
 * to sit and wait.
 */
function FailedPhonelessNote({
  wabas,
}: {
  wabas: AccountResources["wabas"];
}) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-(--line) pt-3">
      <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        Connection failed
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {wabas.map((waba) => (
          <li
            key={waba.wabaId}
            className="max-w-prose text-sm text-pretty text-muted-foreground"
          >
            <span className="font-medium text-foreground">{waba.wabaId}</span>
            {waba.provisioningError ? ` — ${waba.provisioningError}` : null}
          </li>
        ))}
      </ul>
      <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
        Connect the number again to retry.
      </p>
    </div>
  );
}

/**
 * The one coexistence state an operator has to be told about, because it
 * silently changes what the number is (eccos-vss).
 *
 * Eccos asked Meta for a WhatsApp Business app onboarding and Meta reports it
 * did not perform one, so the contacts and message-history syncs were never
 * requested — correctly, since each is allowed exactly once and a wrong one
 * costs the customer their onboarding. Nothing is broken and there is no action
 * to offer: the number works as an ordinary Cloud API number. What would be
 * wrong is leaving somebody waiting for chat history that is never coming.
 *
 * Same structure as the pending note, and for the same reason: this is
 * information, not an alarm.
 */
function NotCoexistenceNote({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-(--line) pt-3">
      <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        No WhatsApp Business app history
      </p>
      <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
        {count === 1
          ? "This number was connected as a WhatsApp Business app number, but Meta reports it is not one. It works normally for sending and receiving; its existing WhatsApp Business app chats and contacts were not synchronised and will not be."
          : `${count} numbers were connected as WhatsApp Business app numbers, but Meta reports they are not. They work normally for sending and receiving; their existing WhatsApp Business app chats and contacts were not synchronised and will not be.`}
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
