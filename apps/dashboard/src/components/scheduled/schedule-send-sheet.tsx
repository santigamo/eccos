import { useState } from "react";
import type { ScheduledSend } from "@eccos/gateway-contract";
import { analyzeTemplate } from "@eccos/core/template-rules";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { failureCopy } from "../../lib/failure";
import {
  DEFAULT_DELAY_MS,
  consoleKey,
  instantOf,
  randomSuffix,
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

const NOT_SCHEDULED = "Not scheduled";

/**
 * "Schedule a send", in the task register: one approved template to one person at one
 * time, beside the list it lands in. Typed input or a request in flight refuses backdrop
 * and Escape; the X always closes. Meta's examples are placeholders only, because the
 * recipient is a real person.
 */
export function ScheduleSendSheet({
  wabaId,
  phones,
  onOpenChange,
  onScheduled,
}: {
  wabaId: string;
  phones: SendTestPhone[];
  onOpenChange: (open: boolean) => void;
  onScheduled: (scheduled: ScheduledSend) => void;
}) {
  const [now] = useState(() => new Date());
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [suffix] = useState(randomSuffix);
  const [draft, setDraft] = useState<WhenDraft>(() => {
    const when = tomorrowAtNine(now);
    return { when, delayMs: DEFAULT_DELAY_MS, key: consoleKey(when, suffix) };
  });
  const [keyTyped, setKeyTyped] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const guarded = dirty || busy;
  const sendAt = instantOf(draft.when);
  const problem = whenProblem(sendAt, Date.now());

  // The key follows the day and time until it is typed over.
  function change(next: WhenDraft) {
    const typed = keyTyped || next.key !== draft.key;
    setKeyTyped(typed);
    setDirty(true);
    setDraft(typed ? next : { ...next, key: consoleKey(next.when, suffix) });
  }

  async function submit(payload: SendTestPayload): Promise<FailureNotice | null> {
    const at = instantOf(draft.when);
    const refused = whenProblem(at, Date.now());
    if (refused !== null || at === null) return { title: NOT_SCHEDULED, detail: refused ?? "" };
    setBusy(true);
    try {
      const result = await scheduleSend({
        data: { ...payload, key: draft.key, sendAt: at, expiresAt: at + draft.delayMs },
      });
      if (!result.ok) return failureCopy(result);
      if (!result.data.ok) {
        return scheduleFailureCopy(result.data, `${payload.templateName} (${payload.languageCode})`);
      }
      onScheduled(result.data.scheduled);
      return null;
    } catch {
      return { title: NOT_SCHEDULED, detail: "The console could not complete the request. Check the list before trying again." };
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      disablePointerDismissal={guarded}
      onOpenChange={(next, details) => {
        if (!next && guarded && details.reason !== "close-press") {
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
