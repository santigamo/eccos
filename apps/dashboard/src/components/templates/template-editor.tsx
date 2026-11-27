import { useEffect, useState } from "react";
import { Link, useBlocker, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { analyzeTemplate, canSendTemplate, normalizeTemplateName } from "@eccos/core/template-rules";
import { COUNT_LINK, Page, SPLIT_GRID, SPLIT_MAIN, StatusTag } from "../../ui";
import { IDENTITY_TIER, MACHINE_CLASS, SECONDARY_TIER, SectionHeading, SUPPORT_TIER } from "../dashboard/plain-table";
import { Row, Rows, SectionFrame } from "../dashboard/settings-section";
import { createTemplate, editTemplate } from "../../server/gateway";
import { createTemplateFailureCopy, editTemplateFailureCopy } from "../../lib/failure";
import { invalidatePage, invalidateRoutes } from "../../lib/invalidate";
import { blankDraft, CATEGORIES, exampleValues, type LanguageDraft, type TemplateCategory } from "../../lib/template-draft";
import {
  barBlocker,
  applySend,
  barNote,
  buildTabs,
  categoryLock,
  categoryMovable,
  groupCategory,
  listLanguages,
  primaryLabel,
  refusalLine,
  submission,
  tabState,
  type AuthoringMode,
  type LanguageState,
  type LanguageTab,
  type Notice,
  storedView,
  type TabState,
} from "../../lib/template-group";
import { dropHandoff, peekHandoff, putHandoff } from "../../lib/template-handoff";
import { languageLabel, mostUsedLanguage, nextFreeLanguage } from "../../lib/template-languages";
import { afterCreate, movedCategory, refusal, requestFor, submitSerially } from "../../lib/template-submit";
import { authoringReading, categoryLabel, templateView, type TemplateRecord } from "../../lib/template-view";
import { DeleteTemplateDialog, type DeleteTarget } from "./delete-template-dialog";
import { DiscardDraftDialog } from "./discard-draft-dialog";
import { LanguagePanel } from "./language-panel";
import { SendTestSheet, type SendTestPhone } from "./send-test-sheet";
import { WhatsAppPreview } from "./whatsapp-preview";

/** Everything the page holds beyond what Meta already has. */
interface AuthoringState {
  name: string;
  category: TemplateCategory;
  initialCategory: TemplateCategory;
  languages: Record<string, LanguageState>;
}

export interface TemplateEditorProps {
  mode: AuthoringMode;
  wabaId: string;
  /** The `wabaId` search param, carried on every link. */
  wabaParam?: string;
  businessName: string;
  /** The WABA's numbers, the senders a test can go from. */
  phones: SendTestPhone[];
  /** Every template row the list loaded. */
  rows: TemplateRecord[];
  /** The template name being edited. */
  name?: string;
  /** `?language=`: the selected tab, and on /templates/new the duplicated language. */
  language?: string;
  /** `?from=`: the template a new one duplicates. */
  from?: string;
  /** `?add=1`: open with a new language draft. */
  add?: boolean;
  /** Selects a tab, replacing `?language=` (and dropping `?add`). */
  onLanguage: (code: string) => void;
}

const STATE_INK: Record<TabState, string> = {
  INCOMPLETE: "text-warning-foreground",
  EDITED: "text-warning-foreground",
  "IN REVIEW": "text-muted-foreground",
  REJECTED: "text-destructive-foreground",
  "NOT CREATED": "text-destructive-foreground",
  "EDIT REFUSED": "text-destructive-foreground",
};

/**
 * The router blocker for a page holding unsent work: the browser's leave-page
 * warning, and a block on in-app navigation to another path. A change of
 * `?language=` is a tab switch on the same page, never a departure.
 */
export function leaveBlocker(guarded: boolean) {
  return {
    shouldBlockFn: ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) =>
      guarded && current.pathname !== next.pathname,
    enableBeforeUnload: guarded,
    withResolver: true as const,
  };
}

function initialState({ mode, rows, name, language, from, add }: TemplateEditorProps): AuthoringState {
  const start = (category: TemplateCategory, languages: Record<string, LanguageState>, ownName = "") => ({
    name: ownName,
    category,
    initialCategory: category,
    languages,
  });
  if (mode === "create") {
    const source = from
      ? (rows.find((row) => row.name === from && row.language === language) ?? rows.find((row) => row.name === from))
      : undefined;
    const reading = source ? authoringReading(source) : null;
    if (reading?.ok) {
      const { name: _name, category, ...draft } = reading.draft;
      return start(category, { [draft.language]: { added: true, draft, seed: draft } });
    }
    return start("UTILITY", { [language ?? mostUsedLanguage(rows)]: { added: true } });
  }
  const handoff = name ? peekHandoff(name) : undefined;
  if (handoff) return start(handoff.category, handoff.languages, name);
  const group = rows.filter((row) => row.name === name);
  const extra = add ? nextFreeLanguage(group.flatMap((row) => (row.language ? [row.language] : []))) : null;
  return start(groupCategory(group), extra ? { [extra]: { added: true } } : {}, name);
}

/**
 * Authoring one template name across its languages: the shared name and
 * category, one tab per language, the preview of the active one, and a single
 * primary that sends every language that needs sending, one call at a time.
 */
export function TemplateEditor(props: TemplateEditorProps) {
  const { mode, wabaId, wabaParam, businessName, phones, rows, onLanguage } = props;
  const router = useRouter();
  const navigate = useNavigate();
  const [state, setState] = useState(() => initialState(props));
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState(() => (props.name && peekHandoff(props.name)?.receipt) || "");
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [testing, setTesting] = useState<TemplateRecord | null>(null);
  const name = state.name;

  const group = mode === "edit" ? rows.filter((row) => row.name === name) : [];
  const lock = mode === "edit" ? categoryLock(group) : null;
  const tabs = buildTabs({ ...state, rows: group });
  const active = tabs.find((tab) => tab.language === props.language) ?? tabs[0];
  const sending = submission(tabs);
  const created = Object.entries(state.languages).flatMap(([code, own]) => (own.added && own.sent ? [code] : []));
  const blocker = barBlocker(mode, name, sending);
  const note = blocker ?? barNote(mode, sending, created);
  const dirty =
    (mode === "create" && (state.name.trim() !== "" || state.category !== state.initialCategory)) ||
    tabs.some((tab) => tab.dirty);
  const leave = useBlocker(leaveBlocker(submitting || dirty));

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only; the page is keyed by template name
  useEffect(() => {
    const opened = Object.keys(state.languages).find((code) => state.languages[code]?.added);
    if (props.add && mode === "edit" && opened) onLanguage(opened);
    if (mode === "edit") dropHandoff(name);
  }, []);

  const taken = tabs.map((tab) => tab.language);
  const freeLanguage = nextFreeLanguage(taken);

  function setLanguages(patch: (languages: Record<string, LanguageState>) => Record<string, LanguageState>) {
    setState((prev) => ({ ...prev, languages: patch(prev.languages) }));
  }

  function patchLanguage(code: string, patch: Partial<LanguageState>) {
    setLanguages((languages) => ({ ...languages, [code]: { ...languages[code], ...patch } }));
  }

  function addLanguage() {
    if (!freeLanguage) return;
    patchLanguage(freeLanguage, { added: true });
    onLanguage(freeLanguage);
  }

  function renameDraft(from: string, to: string) {
    setLanguages((languages) =>
      Object.fromEntries(
        Object.entries(languages).map(([code, own]) =>
          code === from ? [to, { added: true, draft: { ...(own.draft ?? blankDraft(to)), language: to } }] : [code, own],
        ),
      ),
    );
    onLanguage(to);
  }

  function forget(code: string) {
    setLanguages(({ [code]: _gone, ...rest }) => rest);
  }

  async function send(tab: LanguageTab, moved: string[]): Promise<Notice | null> {
    const request = requestFor(tab, { wabaId, name, category: state.category });
    if (request.kind === "edit") return refusal(await editTemplate({ data: request.data }), editTemplateFailureCopy);
    const result = await createTemplate({ data: request.data });
    const category = movedCategory(result, state.category);
    if (category) moved.push(`Meta categorized ${languageLabel(tab.language)} as ${category}.`);
    return refusal(result, createTemplateFailureCopy);
  }

  async function submit() {
    if (blocker || submitting) return;
    setSubmitting(true);
    setReceipt("");
    const moved: string[] = [];
    const outcome = await submitSerially(sending, (tab) => send(tab, moved)).finally(() => setSubmitting(false));
    const done = outcome.done;
    const failed = outcome.failed ? { language: outcome.failed.item.language, notice: outcome.failed.notice } : null;
    const receipt = [
      done.length > 0 ? `${listLanguages(done.map((tab) => tab.language))} sent to Meta for review.` : null,
      ...moved,
      outcome.failed ? refusalLine({ ...outcome.failed.item, error: outcome.failed.notice }) : null,
    ]
      .filter(Boolean)
      .join(" ");

    if (mode === "create") {
      const next = afterCreate(name, wabaParam, done.length, failed?.language ?? null);
      if (next) {
        if (next.to === "/templates") {
          toast(`${name} submitted in ${done.length} ${done.length === 1 ? "language" : "languages"}.`, {
            description: ["Meta reviews each one, usually within minutes.", ...moved].join(" "),
          });
        } else {
          // Created languages are `added` and `sent`; the rest keep their drafts and the refusal.
          const languages = applySend(state.languages, done.map((tab) => tab.draft), failed);
          putHandoff(name, { category: state.category, languages, receipt });
        }
        await invalidateRoutes(router, "/templates");
        navigate(next);
        return;
      }
    }

    setState((prev) => ({ ...prev, languages: applySend(prev.languages, done.map((tab) => tab.draft), failed) }));
    setReceipt(receipt);
    if (failed) onLanguage(failed.language);
    if (done.length > 0) invalidatePage(router);
  }

  const previewValues = active
    ? Object.fromEntries(
        exampleValues(active.draft).flatMap((value, index) => (value.trim() ? [[String(index + 1), value.trim()]] : [])),
      )
    : {};
  const stored = active ? storedView(active) : null;
  const reviewed = tabs.filter((tab) => tab.status !== null || tab.error);
  const listSearch = { wabaId: wabaParam };
  const duplicable = active?.row ? authoringReading(active.row).ok : false;
  const categoryNote = lock ?? (group.some((row) => !categoryMovable(row)) ? "Applies to rejected and paused languages" : null);

  return (
    <Page
      title={mode === "create" ? "New template" : name}
      kicker="Cloud API"
      actions={
        <Link
          to="/templates"
          search={listSearch}
          className={`inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground ${COUNT_LINK}`}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
          Templates
        </Link>
      }
    >
      <div className={SPLIT_GRID}>
        <div className={`flex flex-col gap-8 ${SPLIT_MAIN}`}>
          {/* Nothing changes under a send in flight: the fields are what is being sent. */}
          <fieldset disabled={submitting} className="m-0 flex min-w-0 flex-col gap-8 border-0 p-0">
            <section aria-labelledby="template-shared-title" className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <SectionHeading id="template-shared-title" title="Template" />
                <p className={`m-0 ${SUPPORT_TIER}`}>
                  {mode === "create"
                    ? "Shared by every language. The name can't be changed once Meta has it."
                    : "Shared by every language."}
                </p>
              </div>
              {mode === "create" ? (
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
                  <div>
                    <label htmlFor="template-name" className={`mb-1 block ${MACHINE_CLASS}`}>
                      Name
                    </label>
                    <Input
                      id="template-name"
                      autoComplete="off"
                      className="font-mono"
                      value={state.name}
                      placeholder="order_update"
                      // Coerced as typed, as WhatsApp Manager does, so it never shows a name Meta would refuse.
                      onChange={(event) => setState((prev) => ({ ...prev, name: normalizeTemplateName(event.target.value) }))}
                    />
                    <p className="m-0 mt-1 text-xs text-muted-foreground">Lowercase letters, numbers and underscores.</p>
                  </div>
                  <CategoryField value={state.category} onChange={(category) => setState((prev) => ({ ...prev, category }))} />
                </div>
              ) : (
                <SectionFrame flush>
                  <Rows>
                    <Row
                      label="Name"
                      action={
                        duplicable && active ? (
                          <Link
                            to="/templates/new"
                            search={{ wabaId: wabaParam, from: name, language: active.language }}
                            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                          >
                            Duplicate as new name
                          </Link>
                        ) : null
                      }
                    >
                      <span className="font-mono text-sm font-normal">{name}</span>
                    </Row>
                    <Row label="Category" action={categoryNote ? <span className={SECONDARY_TIER}>{categoryNote}</span> : null}>
                      {lock ? (
                        categoryLabel(state.category)
                      ) : (
                        <CategoryField value={state.category} onChange={(category) => setState((prev) => ({ ...prev, category }))} bare />
                      )}
                    </Row>
                  </Rows>
                </SectionFrame>
              )}
            </section>

            <section aria-labelledby="template-content-title" className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <SectionHeading id="template-content-title" title="Content" />
                <p className={`m-0 ${SUPPORT_TIER}`}>One version per language. Meta reviews each one on its own.</p>
              </div>
              {active ? (
                <SectionFrame flush>
                  <Tabs value={active.language} onValueChange={(value) => onLanguage(String(value))}>
                    <div className="flex items-stretch border-b border-(--line)">
                      <TabsList aria-label="Languages" className="overflow-x-auto">
                        {tabs.map((tab) => (
                          <LanguageTabLabel key={tab.language} tab={tab} />
                        ))}
                      </TabsList>
                      {freeLanguage ? (
                        <button
                          type="button"
                          onClick={addLanguage}
                          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-l border-(--line) px-4 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                        >
                          <PlusIcon aria-hidden="true" className="size-3.5" />
                          Add language
                        </button>
                      ) : null}
                    </div>
                    <TabsPanel value={active.language} className="p-5">
                      <LanguagePanel
                        key={active.language}
                        tab={active}
                        wabaId={wabaId}
                        takenLanguages={taken.filter((code) => code !== active.language)}
                        canRemove={tabs.length > 1}
                        onChange={(draft: LanguageDraft) => patchLanguage(active.language, { draft })}
                        onLanguageChange={(code) => renameDraft(active.language, code)}
                        onRemove={() => {
                          forget(active.language);
                          const rest = tabs.find((tab) => tab.language !== active.language);
                          if (rest) onLanguage(rest.language);
                        }}
                        onSend={
                          active.row && phones.length > 0 && canSendTemplate(active.row.status)
                            ? () => setTesting(active.row)
                            : undefined
                        }
                        onDelete={
                          active.row?.id && active.row.status?.toUpperCase() !== "PENDING_DELETION"
                            ? () =>
                                setDeleting({
                                  templateId: active.row?.id ?? "",
                                  name,
                                  language: active.language,
                                  status: active.row?.status,
                                })
                            : undefined
                        }
                      />
                    </TabsPanel>
                  </Tabs>
                </SectionFrame>
              ) : null}
              {/* Mounted even when empty: a live region that appears with its message is not reliably announced. */}
              <output aria-live="polite" aria-atomic="true" className={receipt ? `block ${SUPPORT_TIER}` : undefined}>
                {receipt}
              </output>
            </section>
          </fieldset>

          {active && !active.readOnly ? (
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-4 border-t border-(--line) bg-background py-4">
              <p className="m-0 min-w-0 flex-1 text-sm text-pretty text-muted-foreground">{note}</p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-none"
                  onClick={() => navigate({ to: "/templates", search: listSearch })}
                >
                  Cancel
                </Button>
                <Button type="button" aria-busy={submitting} disabled={Boolean(blocker) || submitting} onClick={submit}>
                  {submitting ? "Submitting…" : primaryLabel(mode, sending, active.language)}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-4" aria-label="Preview">
          {active ? (
            <div className="flex flex-col gap-2">
              <p className={`m-0 ${MACHINE_CLASS}`}>Preview · {languageLabel(active.language)}</p>
              {stored ? (
                <WhatsAppPreview
                  businessName={businessName}
                  header={stored.header}
                  headerValues={stored.headerExamples}
                  body={stored.body}
                  bodyValues={stored.bodyExamples}
                  footer={stored.footer}
                  buttons={stored.buttons}
                  markValues
                />
              ) : (
                <WhatsAppPreview
                  businessName={businessName}
                  header={null}
                  body={active.draft.body}
                  bodyValues={previewValues}
                  footer={active.draft.footer.trim()}
                  buttons={active.draft.buttons.map((button) => ({ kind: "url" as const, text: button.text }))}
                  markValues
                />
              )}
            </div>
          ) : null}
          {mode === "edit" && reviewed.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className={`m-0 ${MACHINE_CLASS}`}>Meta review</p>
              <ul className="m-0 list-none divide-y divide-(--line) border-y border-(--line) p-0">
                {reviewed.map((tab) => {
                  const category = tab.row?.category?.toUpperCase();
                  return (
                    <li key={tab.language} className="flex items-center gap-3 py-2.5">
                      <span className={IDENTITY_TIER}>{languageLabel(tab.language)}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{tab.language}</span>
                      {category && category !== state.category ? (
                        <span className={SECONDARY_TIER}>{categoryLabel(category)}</span>
                      ) : null}
                      <span className="ml-auto">
                        <StatusTag status={tab.status ?? "not created"} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>

      {leave.status === "blocked" ? (
        <DiscardDraftDialog submitting={submitting} editing={mode === "edit"} onKeep={leave.reset} onDiscard={leave.proceed} />
      ) : null}

      {testing ? (
        <SendTestSheet
          key={`${testing.name}:${testing.language}`}
          open
          onOpenChange={(open) => {
            if (!open) setTesting(null);
          }}
          wabaId={wabaId}
          templateName={testing.name ?? ""}
          languageCode={testing.language ?? ""}
          status={testing.status}
          sendability={analyzeTemplate(testing)}
          phones={phones}
          view={templateView(testing)}
        />
      ) : null}

      {deleting ? (
        <DeleteTemplateDialog
          wabaId={wabaId}
          target={deleting}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onDeleted={() => {
            const rest = tabs.find((tab) => tab.language !== deleting.language);
            forget(deleting.language);
            invalidatePage(router);
            if (rest) onLanguage(rest.language);
            else navigate({ to: "/templates", search: listSearch, ignoreBlocker: true });
          }}
        />
      ) : null}
    </Page>
  );
}

/** A tab: the language, its code in mono, and its state word, which is also in its accessible name. */
function LanguageTabLabel({ tab }: { tab: LanguageTab }) {
  const state = tabState(tab);
  const label = languageLabel(tab.language);
  return (
    <TabsTab value={tab.language} aria-label={`${label}, ${tab.language}${state ? `, ${state.toLowerCase()}` : ""}`}>
      <span>{label}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{tab.language}</span>
      {state ? <span className={cn(MACHINE_CLASS, STATE_INK[state])}>{state}</span> : null}
    </TabsTab>
  );
}

function CategoryField({
  value,
  onChange,
  bare,
}: {
  value: TemplateCategory;
  onChange: (category: TemplateCategory) => void;
  /** Inside a label/value row, which already names it. */
  bare?: boolean;
}) {
  const select = (
    <Select value={value} onValueChange={(next) => next && onChange(next as TemplateCategory)}>
      <SelectTrigger id="template-category" aria-label={bare ? "Category" : undefined} className="w-full max-w-xs rounded-none">
        <SelectValue>{(current: string) => categoryLabel(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {CATEGORIES.map((entry) => (
          <SelectItem key={entry.value} value={entry.value}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (bare) return select;
  return (
    <div>
      <label htmlFor="template-category" className={`mb-1 block ${MACHINE_CLASS}`}>
        Category
      </label>
      {select}
      <p className="m-0 mt-1 text-xs text-muted-foreground">Meta may reassign it on review.</p>
    </div>
  );
}

/** The page's own shape while the template list loads. */
export function TemplateEditorPending({ title }: { title: string }) {
  return (
    <Page title={title} kicker="Cloud API">
      <div className={SPLIT_GRID} aria-busy="true">
        <div className={`flex flex-col gap-6 ${SPLIT_MAIN}`}>
          <Skeleton className="h-24" />
          <Skeleton className="h-96" />
        </div>
        <Skeleton className="h-72" />
      </div>
    </Page>
  );
}
