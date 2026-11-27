import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusTag } from "../../ui";
import { MACHINE_CLASS, SECONDARY_TIER, SUPPORT_TIER } from "../dashboard/plain-table";
import { APPROVED_EDIT_NOTICE, type LanguageDraft } from "../../lib/template-draft";
import { refusalLine, type LanguageTab } from "../../lib/template-group";
import { languageLabel, languageOptions } from "../../lib/template-languages";
import { authoringReading, lastUpdated, qualityReading, rejectionReason } from "../../lib/template-view";
import { LanguageFields, LanguageReadOnly } from "./language-fields";
import { managerUrl } from "./template-preview-sheet";

/** The line beside an existing language's status tag. */
function metaLine(tab: LanguageTab): string {
  if (!tab.row) return "Submitted from this page";
  const quality = qualityReading(tab.row);
  const updated = lastUpdated(tab.row);
  return [quality ? `Quality ${quality.label}` : null, updated ? `updated ${updated.toISOString().slice(0, 10)}` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One language's panel: what it is at Meta (or the language picker for a draft),
 * the callout its state calls for, and its content, editable or read-only.
 */
export function LanguagePanel({
  tab,
  wabaId,
  takenLanguages,
  canRemove,
  onChange,
  onLanguageChange,
  onRemove,
  onDelete,
}: {
  tab: LanguageTab;
  wabaId: string;
  /** Codes the other tabs use, so a draft cannot pick one twice. */
  takenLanguages: string[];
  canRemove: boolean;
  onChange: (draft: LanguageDraft) => void;
  onLanguageChange: (code: string) => void;
  onRemove: () => void;
  onDelete?: () => void;
}) {
  const label = languageLabel(tab.language);
  const rejected = tab.status === "REJECTED" && tab.row ? rejectionReason(tab.row) : null;
  const isDraft = tab.status === null;

  return (
    <div className="flex flex-col gap-6">
      {isDraft ? (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="w-full max-w-xs">
            <label htmlFor="template-language" className={`mb-1 block ${MACHINE_CLASS}`}>
              Language
            </label>
            <Select value={tab.language} onValueChange={(value) => value && onLanguageChange(value)}>
              <SelectTrigger id="template-language" className="w-full rounded-none">
                <SelectValue>{(value: string) => `${languageLabel(value)} · ${value}`}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                {languageOptions(tab.language, takenLanguages).map((entry) => (
                  <SelectItem key={entry.code} value={entry.code}>
                    {entry.label} {"·"} {entry.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {canRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Remove this language
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {tab.status ? <StatusTag status={tab.status} /> : null}
          <span className={`min-w-0 flex-1 ${SECONDARY_TIER}`}>{metaLine(tab)}</span>
          {onDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="outline" size="icon-sm" className="rounded-none" aria-label={`Actions for ${label}`} />
                }
              >
                <MoreHorizontalIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}

      {tab.error ? (
        <Callout tone="error">
          <p className="m-0 font-medium text-foreground">{refusalLine(tab)}</p>
          <p className={`m-0 mt-1 ${SUPPORT_TIER}`}>
            {tab.error.title}. {tab.error.detail}
          </p>
          {tab.error.secondary ? (
            <p className="m-0 mt-1 font-mono text-xs break-words text-muted-foreground">{tab.error.secondary}</p>
          ) : null}
        </Callout>
      ) : null}

      {tab.status === "REJECTED" ? (
        <Callout tone="error">
          <p className="m-0 font-medium text-foreground">
            Meta rejected {label}: {rejected ?? "no reason given"}.
          </p>
          <p className={`m-0 mt-1 ${SUPPORT_TIER}`}>
            Change what Meta flagged and submit it again. If the message is meant to sell, duplicate it as a Marketing
            template.
          </p>
        </Callout>
      ) : null}

      {tab.status === "APPROVED" && tab.dirty ? <Callout tone="warning">{APPROVED_EDIT_NOTICE}</Callout> : null}

      {tab.readOnly ? (
        <>
          <p className={`m-0 max-w-prose text-pretty ${SUPPORT_TIER}`}>
            {tab.readOnly}
            {tab.row && !authoringReading(tab.row).ok ? (
              <>
                {" Edit or duplicate it in "}
                <a href={managerUrl(wabaId)} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  WhatsApp Manager
                </a>
                .
              </>
            ) : null}
          </p>
          <LanguageReadOnly draft={tab.draft} />
        </>
      ) : (
        <LanguageFields draft={tab.draft} onChange={onChange} wabaId={wabaId} />
      )}
    </div>
  );
}
