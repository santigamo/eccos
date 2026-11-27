import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ScheduledSend, ScheduleSendInput } from "@eccos/gateway-contract";
import { analyzeTemplate } from "@eccos/core/template-rules";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { failureCopy } from "../../lib/failure";
import {
  DEFAULT_DELAY_MS,
  NOT_SCHEDULED,
  type When,
  consoleKey,
  instantOf,
  isSameSend,
  randomSuffix,
  recipientProblem,
  resolvedWhen,
  scheduleFailureCopy,
  shortWhen,
  tomorrowAtNine,
  whenProblem,
} from "../../lib/schedule-draft";
import { templateView } from "../../lib/template-view";
import { scheduleSend } from "../../server/gateway";
import { TemplateChoice } from "../conversations/send-template-sheet";
import { type FailureNotice, SendTestForm, type SendTestPayload, type SendTestPhone } from "../templates/send-test-sheet";
import { ScheduleWhen, type WhenDraft } from "./schedule-when";

type Outcome = { scheduled: ScheduledSend } | { failure: FailureNotice };

/** Typed input or a request in flight refuses backdrop and Escape; the X (`close-press`) always closes. */
export function refusesClose(state: { guarded: boolean; reason: string }): boolean {
  return state.guarded && state.reason !== "close-press";
}

const keyFor = (when: When, suffix: string) => consoleKey(resolvedWhen(when, instantOf(when)), suffix);

/**
 * "Schedule a send", in the task register: one approved template to one person at one
 * time, beside the list it lands in. Meta's examples are placeholders only, because the
 * recipient is a real person.
 */
export function ScheduleSendSheet({
  wabaId,
  phones,
  onOpenChange,
  onScheduled,
  onStale,
}: {
  wabaId: string;
  phones: SendTestPhone[];
  onOpenChange: (open: boolean) => void;
  onScheduled: (scheduled: ScheduledSend) => void;
  /** The list behind the sheet no longer holds every send: re-read it. */
  onStale: () => void;
}) {
  const [now] = useState(() => new Date());
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [suffix] = useState(randomSuffix);
  const [draft, setDraft] = useState<WhenDraft>(() => {
    const when = tomorrowAtNine(now);
    return { when, delayMs: DEFAULT_DELAY_MS, key: keyFor(when, suffix) };
  });
  const [keyTyped, setKeyTyped] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // An answer that lands after the X belongs to no sheet: it must not close a reopened one.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const guarded = dirty || busy;
  const sendAt = instantOf(draft.when);
  const problem = whenProblem(sendAt, Date.now());

  // The key follows the time the send will go out at, until it is typed over.
  function change(next: WhenDraft) {
    const typed = keyTyped || next.key !== draft.key;
    setKeyTyped(typed);
    setDirty(true);
    setDraft(typed ? next : { ...next, key: keyFor(next.when, suffix) });
  }

  async function request(data: ScheduleSendInput): Promise<Outcome> {
    const template = `${data.templateName} (${data.languageCode})`;
    try {
      const result = await scheduleSend({ data });
      if (!result.ok) return { failure: failureCopy(result) };
      if (result.data.ok) return { scheduled: result.data.scheduled };
      const { existing } = result.data;
      if (result.data.code === "key_exists" && existing) {
        // A retry whose first answer was lost finds its own send: that is success.
        if (isSameSend(existing, data)) return { scheduled: existing };
        onStale();
      }
      return { failure: scheduleFailureCopy(result.data, template) };
    } catch {
      return {
        failure: { title: NOT_SCHEDULED, detail: "The console could not complete the request. Check the list before trying again." },
      };
    }
  }

  async function submit(payload: SendTestPayload): Promise<FailureNotice | null> {
    const at = instantOf(draft.when);
    const refused = recipientProblem(payload.to) ?? whenProblem(at, Date.now());
    if (refused !== null || at === null) return { title: NOT_SCHEDULED, detail: refused ?? "" };
    setBusy(true);
    const outcome = await request({ ...payload, key: draft.key, sendAt: at, expiresAt: at + draft.delayMs });
    if (!mounted.current) {
      if ("scheduled" in outcome) {
        toast(`Scheduled for ${shortWhen(outcome.scheduled.sendAt)}`);
        onStale();
      } else {
        toast.warning(outcome.failure.title, { description: outcome.failure.detail });
      }
      return null;
    }
    setBusy(false);
    if ("failure" in outcome) return outcome.failure;
    onScheduled(outcome.scheduled);
    return null;
  }

  return (
    <Sheet
      open
      disablePointerDismissal={guarded}
      onOpenChange={(next, details) => {
        if (!next && refusesClose({ guarded, reason: details.reason })) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="gap-2 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="gap-1.5">
          <SheetTitle className="text-lg font-semibold tracking-[-0.01em]">Schedule a send</SheetTitle>
          <SheetDescription>One approved template, to one person, at a time you choose.</SheetDescription>
        </SheetHeader>
        <TemplateChoice wabaId={wabaId} emptyDescription="Only an approved template can be scheduled. Approved templates appear here.">
          {(chosen, back) => (
            <div className="flex flex-col gap-4" onInput={() => setDirty(true)}>
              <p className="m-0 flex flex-wrap items-center gap-2.5 border-b border-(--line) px-4 pb-4">
                <span className="font-mono text-xs break-all text-foreground">
                  {chosen.name} {"·"} {chosen.language}
                </span>
                <button
                  type="button"
                  className="cursor-pointer text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  onClick={back}
                >
                  Change template
                </button>
              </p>
              <SendTestForm
                key={`${chosen.name}:${chosen.language}`}
                wabaId={wabaId}
                templateName={chosen.name ?? ""}
                languageCode={chosen.language ?? ""}
                sendability={analyzeTemplate(chosen)}
                phones={phones}
                view={templateView(chosen)}
                schedule={{
                  label: sendAt !== null && problem === null ? `Schedule for ${shortWhen(sendAt)}` : "Schedule",
                  submit,
                  fields: (
                    <ScheduleWhen
                      draft={draft}
                      onChange={change}
                      sendAt={sendAt}
                      problem={problem}
                      now={now}
                      timeZone={timeZone}
                    />
                  ),
                }}
              />
            </div>
          )}
        </TemplateChoice>
      </SheetContent>
    </Sheet>
  );
}
