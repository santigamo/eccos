import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { GridEmptyState } from "../grid/empty-state";
import { FactRow, SheetSection } from "../logs/sheet-parts";
import { StatusTag } from "../../ui";
import {
  categoryLabel,
  lastUpdated,
  qualityReading,
  rejectionReason,
  templateView,
  type TemplateRecord,
} from "../../lib/template-view";
import { WhatsAppPreview } from "./whatsapp-preview";

/**
 * One template, inspected: how it reads on the customer's phone (with the
 * example values Meta reviewed), Meta's verdict on it, and the acts it allows.
 *
 * Inspection register. The acts below only open their own task sheet (send,
 * edit, duplicate); nothing here writes by itself.
 */

export interface TemplateActions {
  onSend?: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  /** Why edit and duplicate are not offered, when they are not. */
  authoringBlocked?: string | null;
}

const QUALITY_INK = {
  neutral: "text-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive-foreground",
};

/** Best-effort deep link into WhatsApp Manager's template list for this WABA. */
export function managerUrl(wabaId: string): string {
  return `https://business.facebook.com/wa/manage/message-templates/?waba_id=${encodeURIComponent(wabaId)}`;
}

function variableKey(key: string): string {
  return `{{${key}}}`;
}

export function TemplateDetail({
  row,
  wabaId,
  businessName,
  actions = {},
}: {
  row: TemplateRecord;
  wabaId: string;
  businessName: string;
  actions?: TemplateActions;
}) {
  const view = templateView(row);
  if (!view) {
    return (
      <div className="px-4 pb-4">
        <GridEmptyState
          label="No preview"
          description="Meta returned this template without its components, so there is nothing to preview."
        />
      </div>
    );
  }

  const quality = qualityReading(row);
  const rejected = rejectionReason(row);
  const updated = lastUpdated(row);
  const variables = Object.entries(view.bodyExamples);
  const links = view.buttons.filter((button) => button.url);
  const hasActions = Boolean(actions.onSend || actions.onEdit || actions.onDuplicate);

  return (
    <div className="grid gap-6 px-4 pb-4 md:grid-cols-[19.5rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-2 self-start">
        <WhatsAppPreview
          businessName={businessName}
          header={view.header}
          headerValues={view.headerExamples}
          body={view.body}
          bodyValues={view.bodyExamples}
          footer={view.footer}
          buttons={view.buttons}
          markValues
        />
        {variables.length > 0 ? (
          <p className="m-0 text-xs text-pretty text-muted-foreground">
            Highlighted text is the example Meta reviewed. Each send fills in its own values.
          </p>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {hasActions ? (
          <div className="flex flex-wrap gap-2">
            {actions.onSend ? (
              <Button type="button" size="sm" onClick={actions.onSend}>
                Send test
              </Button>
            ) : null}
            {actions.onEdit ? (
              <Button type="button" size="sm" variant="outline" className="rounded-none" onClick={actions.onEdit}>
                Edit
              </Button>
            ) : null}
            {actions.onDuplicate ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-none"
                onClick={actions.onDuplicate}
              >
                Duplicate
              </Button>
            ) : null}
          </div>
        ) : null}
        {actions.authoringBlocked ? (
          <p className="m-0 max-w-prose text-xs text-pretty text-muted-foreground">
            {actions.authoringBlocked} Edit it in{" "}
            <a href={managerUrl(wabaId)} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              WhatsApp Manager
            </a>
            .
          </p>
        ) : null}

        <SheetSection label="Review">
          <dl className="m-0">
            <FactRow label="Status" value={row.status ? <StatusTag status={row.status} /> : null} />
            {rejected ? <FactRow label="Rejected for" value={rejected} tone="destructive" /> : null}
            <FactRow
              label="Category"
              value={
                row.previous_category && row.previous_category !== row.category
                  ? `${categoryLabel(row.category)} (was ${categoryLabel(row.previous_category)})`
                  : categoryLabel(row.category)
              }
            />
            {quality ? (
              <FactRow label="Quality" value={<span className={QUALITY_INK[quality.tone]}>{quality.label}</span>} />
            ) : null}
            <FactRow label="Language" value={row.language} mono />
            {updated ? (
              <FactRow label="Last updated" value={`${updated.toISOString().slice(0, 16).replace("T", " ")} UTC`} mono />
            ) : null}
            <FactRow label="Template id" value={row.id} mono />
          </dl>
        </SheetSection>

        {variables.length > 0 ? (
          <SheetSection label="Variables">
            <dl className="m-0">
              {variables.map(([key, example]) => (
                <FactRow key={key} label={variableKey(key)} value={example} />
              ))}
            </dl>
          </SheetSection>
        ) : null}

        {links.length > 0 ? (
          <SheetSection label="Links">
            <dl className="m-0">
              {links.map((button, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: buttons are positional
                <FactRow key={index} label={button.text || `Button ${index + 1}`} value={button.url} mono />
              ))}
            </dl>
          </SheetSection>
        ) : null}
      </div>
    </div>
  );
}

export function TemplatePreviewSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-2 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <SheetHeader className="gap-2">
          <SheetTitle className="font-mono text-sm break-all">{title}</SheetTitle>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
