import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TemplateView } from "../../lib/template-view";
import type { RowCheck, Slot } from "../../lib/recipient-list";
import { fmtCount } from "../../ui";
import { MACHINE_CLASS } from "../dashboard/plain-table";
import { WhatsAppPreview } from "../templates/whatsapp-preview";

/** A row's body values by template key, for the preview and a test send. */
export function rowValues(slots: Slot[], row: RowCheck | undefined): Record<string, string> {
  return Object.fromEntries(
    slots.flatMap((slot, i) => (slot.kind === "body" && row?.values[i] ? [[slot.key, row.values[i] as string]] : [])),
  );
}

/**
 * The message one real row of the list becomes, stepped row by row: what the
 * operator checks is what is sent. `rows` is what can be stepped through: every
 * row while composing, only the recipients on review.
 */
export function RowPreview({
  noun,
  rows,
  index,
  onIndex,
  slots,
  view,
  businessName,
  headerImageUrl,
}: {
  noun: "Row" | "Recipient";
  rows: RowCheck[];
  index: number;
  onIndex: (index: number) => void;
  slots: Slot[];
  view: TemplateView | null;
  businessName: string;
  headerImageUrl: string | null;
}) {
  const row = rows[index];
  if (!view) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className={`m-0 ${MACHINE_CLASS}`}>
          Preview{row ? ` · ${noun} ${fmtCount(index + 1)} of ${fmtCount(rows.length)}` : ""}
        </p>
        {rows.length > 1 ? (
          <div className="flex gap-1">
            <Button type="button" variant="outline" size="icon-xs" aria-label={`Previous ${noun.toLowerCase()}`} disabled={index === 0} onClick={() => onIndex(index - 1)}>
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={`Next ${noun.toLowerCase()}`}
              disabled={index >= rows.length - 1}
              onClick={() => onIndex(index + 1)}
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
      <WhatsAppPreview
        businessName={businessName}
        header={view.header}
        headerValues={view.headerExamples}
        headerImageUrl={headerImageUrl}
        body={view.body}
        bodyValues={row ? rowValues(slots, row) : view.bodyExamples}
        footer={view.footer}
        buttons={view.buttons}
        markValues
      />
      {row ? (
        <p className="m-0 text-sm text-muted-foreground">
          To <span className="font-mono text-foreground">{row.to || "—"}</span>
        </p>
      ) : null}
    </div>
  );
}
