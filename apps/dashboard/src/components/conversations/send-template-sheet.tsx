import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { failureCopy } from "../../lib/failure";
import {
  analyzeTemplate,
  canSendTemplate,
  templateRowsOf,
  type TemplateListRow,
} from "../../lib/template-params";
import { listTemplates } from "../../server/gateway";
import { SendTestForm, type SendTestPhone } from "../templates/send-test-sheet";
import { GridEmptyState } from "../grid/empty-state";

export interface SendTemplateProps {
  wabaId: string;
  /** The customer's number, digits only. */
  waId: string;
  phoneNumberId: string;
  phones: SendTestPhone[];
  onSent: () => void;
}

/**
 * "Send a template" from a conversation, for a customer outside the 24-hour
 * window. It lists the approved templates, as /templates does, and the chosen
 * one opens the same "Send test" form, with this customer as the recipient and
 * this thread's number as the sender.
 */
export function SendTemplateSheet({
  open,
  onOpenChange,
  ...template
}: SendTemplateProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-2">
          <SheetTitle>Send a template</SheetTitle>
        </SheetHeader>
        <TemplateChoice {...template} />
      </SheetContent>
    </Sheet>
  );
}

type Loaded =
  | { kind: "loading" }
  | { kind: "failed"; title: string; detail: string }
  | { kind: "ready"; rows: TemplateListRow[] };

const LOAD_FAILED = {
  title: "Templates did not load",
  detail: "The gateway returned an error while loading message templates.",
};

/** The approved templates the console can fill in, read as /templates reads them. */
function sendableRows(payload: unknown): TemplateListRow[] {
  return templateRowsOf(payload).filter(
    (row) => canSendTemplate(row.status) && Boolean(row.name && row.language) && analyzeTemplate(row).kind === "ready",
  );
}

/** Reads the list when the sheet opens; the chosen template then renders the send form in place of the list. */
function TemplateChoice({ wabaId, waId, phoneNumberId, phones, onSent }: SendTemplateProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [chosen, setChosen] = useState<TemplateListRow | null>(null);

  useEffect(() => {
    let live = true;
    listTemplates({ data: { wabaId } }).then(
      (result) => {
        if (!live) return;
        if (!result.ok) {
          const copy = failureCopy(result);
          setLoaded({ kind: "failed", title: copy.title, detail: copy.detail });
        } else if (!result.data.ok) {
          setLoaded({ kind: "failed", ...LOAD_FAILED });
        } else {
          setLoaded({ kind: "ready", rows: sendableRows(result.data.data) });
        }
      },
      () => {
        if (live) setLoaded({ kind: "failed", ...LOAD_FAILED });
      },
    );
    return () => {
      live = false;
    };
  }, [wabaId]);

  if (loaded.kind === "loading") {
    return (
      <p aria-busy="true" className="m-0 px-4 pb-4 text-sm text-muted-foreground">
        Loading templates…
      </p>
    );
  }

  if (loaded.kind === "failed") {
    return (
      <div className="px-4 pb-4">
        <p role="alert" className="m-0 border-l-2 border-destructive px-3 py-2 text-sm">
          <span className="block text-destructive-foreground">{loaded.title}</span>
          <span className="block text-muted-foreground">{loaded.detail}</span>
        </p>
      </div>
    );
  }

  if (chosen) {
    return (
      <div className="flex flex-col gap-2">
        <div className="px-4">
          <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={() => setChosen(null)}>
            ← Templates
          </Button>
        </div>
        <SendTestForm
          key={`${chosen.name}:${chosen.language}`}
          wabaId={wabaId}
          templateName={chosen.name ?? ""}
          languageCode={chosen.language ?? ""}
          sendability={analyzeTemplate(chosen)}
          phones={phones}
          initialPhoneNumberId={phoneNumberId}
          recipient={waId}
          onSent={onSent}
        />
      </div>
    );
  }

  if (loaded.rows.length === 0) {
    return (
      <div className="px-4 pb-4">
        <GridEmptyState
          label="NO APPROVED TEMPLATES"
          description="Only an approved template can reach a customer outside the window. Approved templates appear here."
        />
      </div>
    );
  }

  return (
    <ul aria-label="Approved templates" className="m-0 flex list-none flex-col gap-2 p-0 px-4 pb-4">
      {loaded.rows.map((row) => (
        <li key={`${row.name}:${row.language}`}>
          <button
            type="button"
            onClick={() => setChosen(row)}
            className="flex w-full items-center justify-between gap-3 border border-(--line-strong) bg-(--ghost-fill) px-3 py-2 text-left outline-none hover:border-(--ghost-edge-hover) focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 cursor-pointer"
          >
            <span className="font-mono text-xs break-all text-foreground">{row.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{row.language}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
