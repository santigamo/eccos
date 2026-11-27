import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DELAYS, dayBounds, longDay, type When, zoneName } from "../../lib/schedule-draft";
import { utcInstant } from "../../lib/send-at";
import { IDENTITY_TIER, MACHINE_CLASS } from "../dashboard/plain-table";

const LABEL = "mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const CHANGE = "shrink-0 cursor-pointer text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground";

export interface WhenDraft {
  when: When;
  delayMs: number;
  key: string;
}

/**
 * The schedule sheet's "When" group: day and time in the viewer's zone, read back with the
 * zone named and the UTC instant, then the expiry and the key as one-line values.
 */
export function ScheduleWhen({
  draft,
  onChange,
  sendAt,
  problem,
  now,
  timeZone,
}: {
  draft: WhenDraft;
  onChange: (draft: WhenDraft) => void;
  sendAt: number | null;
  problem: string | null;
  now: Date;
  timeZone: string;
}) {
  const [editing, setEditing] = useState<{ delay: boolean; key: boolean }>({ delay: false, key: false });
  const bounds = dayBounds(now);
  const delayLabel = DELAYS.find((delay) => delay.ms === draft.delayMs)?.label ?? "";
  const setWhen = (patch: Partial<When>) => onChange({ ...draft, when: { ...draft.when, ...patch } });

  return (
    <div className="flex flex-col gap-3.5">
      <h3 className="m-0 text-sm font-semibold text-foreground">When</h3>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="schedule-day" className={LABEL}>
            Day
          </label>
          <Input
            id="schedule-day"
            type="date"
            required
            min={bounds.min}
            max={bounds.max}
            className="font-mono"
            value={draft.when.day}
            onChange={(event) => setWhen({ day: event.target.value })}
          />
        </div>
        <div className="w-32 shrink-0">
          <label htmlFor="schedule-time" className={LABEL}>
            Time
          </label>
          <Input
            id="schedule-time"
            type="time"
            required
            className="font-mono"
            value={draft.when.time}
            onChange={(event) => setWhen({ time: event.target.value })}
          />
        </div>
      </div>

      <div aria-live="polite" className="border border-(--line) bg-background px-3 py-2.5">
        {problem ? (
          <p className="m-0 text-sm text-destructive-foreground">{problem}</p>
        ) : sendAt !== null ? (
          <>
            <p className={`m-0 ${IDENTITY_TIER}`}>
              {longDay(sendAt)} <span className="font-normal text-muted-foreground">{zoneName(timeZone)}</span>
            </p>
            <p className="m-0 font-mono text-xs text-muted-foreground">{utcInstant(sendAt)}</p>
          </>
        ) : null}
      </div>

      <div className="flex flex-col border-y border-(--line)">
        <div className="flex items-center justify-between gap-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center">
            <span className={`w-23 shrink-0 ${MACHINE_CLASS}`}>If delayed</span>
            {editing.delay ? (
              <Select
                value={String(draft.delayMs)}
                onValueChange={(value) => onChange({ ...draft, delayMs: Number(value) })}
              >
                <SelectTrigger id="schedule-delay" size="sm" aria-label="If delayed" className="w-full rounded-none">
                  <SelectValue>{`Not sent after ${delayLabel}`}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  {DELAYS.map((delay) => (
                    <SelectItem key={delay.ms} value={String(delay.ms)}>
                      Not sent after {delay.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-sm text-foreground">Not sent after {delayLabel}</span>
            )}
          </div>
          {editing.delay ? null : (
            <button type="button" className={CHANGE} onClick={() => setEditing({ ...editing, delay: true })}>
              Change
            </button>
          )}
        </div>
        {editing.delay ? (
          <p className="m-0 pb-2.5 text-xs text-muted-foreground">If Eccos cannot send it by then, it is not sent.</p>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t border-(--line) py-2.5">
          <div className="flex min-w-0 flex-1 items-center">
            <label htmlFor="schedule-key" className={`w-23 shrink-0 ${MACHINE_CLASS}`}>
              Key
            </label>
            {editing.key ? (
              <Input
                id="schedule-key"
                required
                autoComplete="off"
                maxLength={128}
                pattern="[A-Za-z0-9._:\-]{1,128}"
                title="1 to 128 letters, digits and . _ : -"
                className="font-mono"
                value={draft.key}
                onChange={(event) => onChange({ ...draft, key: event.target.value })}
              />
            ) : (
              <span className="font-mono text-xs break-all text-foreground">{draft.key}</span>
            )}
          </div>
          {editing.key ? null : (
            <button type="button" className={CHANGE} onClick={() => setEditing({ ...editing, key: true })}>
              Change
            </button>
          )}
        </div>
        {editing.key ? (
          <p className="m-0 pb-2.5 text-xs text-pretty text-muted-foreground">
            It identifies this send in the list. Do not use a name or a phone number: the key appears in addresses and
            audit lines.
          </p>
        ) : null}
      </div>
    </div>
  );
}
