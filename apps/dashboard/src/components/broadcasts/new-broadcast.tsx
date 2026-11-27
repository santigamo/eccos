import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useBlocker,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  analyzeTemplate,
  type TemplateHeaderMedia,
  type TemplateSendability,
} from "@eccos/core/template-rules";
import type { BroadcastPreflight } from "@eccos/gateway-contract";
import {
  type BroadcastPayload,
  broadcastPayload,
  broadcastTemplates,
  composeNote,
  payloadBytes,
  reviewKey,
  reviewOpen,
  templateId,
} from "../../lib/broadcast-draft";
import {
  type BroadcastFailureCopy,
  broadcastFailureCopy,
  EARLIER_ATTEMPT,
  NO_ANSWER,
} from "../../lib/broadcast-failure";
import { downloadCsv } from "../../lib/download-csv";
import { failureCopy } from "../../lib/failure";
import { invalidateRoutes } from "../../lib/invalidate";
import { leaveBlocker } from "../../lib/leave-blocker";
import type { ListTable } from "../../lib/list-file";
import { countryOf } from "../../lib/phone-number";
import {
  autoMapping,
  checkList,
  exampleCsv,
  type ListCheck,
  type Mapping,
  type Slot,
  skippedCsv,
  slotsOf,
} from "../../lib/recipient-list";
import { runSend, type SendGate } from "../../lib/send-gate";
import {
  type TemplateView,
  templateView,
  type TemplateRecord,
} from "../../lib/template-view";
import { createBroadcast } from "../../server/gateway";
import { COUNT_LINK, fmtCount, Page, SPLIT_GRID, SPLIT_MAIN } from "../../ui";
import { SectionHeading, SUPPORT_TIER } from "../dashboard/plain-table";
import { SectionFrame } from "../dashboard/settings-section";
import { DiscardDraftDialog } from "../templates/discard-draft-dialog";
import {
  SendTestSheet,
  type SendTestPhone,
} from "../templates/send-test-sheet";
import { BroadcastReview, ReviewFacts } from "./broadcast-review";
import { ColumnMapping } from "./column-mapping";
import { ComposeMessage } from "./compose-message";
import { ListInput } from "./list-input";
import { RecipientTable } from "./recipient-table";
import { RowPreview, rowValues } from "./row-preview";

/**
 * What a review froze. Everything Review shows or sends reads from here, never
 * from the live compose state: the payload, its key, the rows, the template.
 */
interface Frozen {
  payload: BroadcastPayload;
  json: string;
  key: string;
  check: ListCheck;
  template: TemplateRecord;
  sendability: TemplateSendability;
  slots: Slot[];
  view: TemplateView | null;
  headerLink: string;
  sender: string;
  /** The list and mapping it was checked from, for its skipped-rows file. */
  table: ListTable;
  mapping: Mapping;
}

interface Failure {
  copy: BroadcastFailureCopy;
  /** Rows the gateway refused, as "# 118 · reason". */
  rows?: string[];
}

const HTTPS_LINK = /^https:\/\/\S+$/;
/** The longest header link a send takes: rows are checked against the gateway's ceiling with it, so typing a link never re-checks the list. */
const LONGEST_LINK = `https://${"x".repeat(2040)}`;
const slug = (text: string) =>
  text.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-") || "list";

/**
 * `/broadcasts/new`: compose (template, list, mapping, row checks) and review
 * (`?step=review`) on one page. The list lives in this component's memory only;
 * entering review freezes one payload and gives it its idempotency key.
 */
export function NewBroadcast({
  wabaId,
  wabaParam,
  templates,
  preflight,
  phones,
  blocked,
  initialTemplate,
  reviewing: wantsReview,
  onStep,
}: {
  wabaId: string;
  wabaParam?: string;
  templates: TemplateRecord[];
  preflight: BroadcastPreflight;
  phones: SendTestPhone[];
  /** Why no broadcast can start now (billing), or null. */
  blocked: string | null;
  initialTemplate?: string;
  reviewing: boolean;
  /** `replace` drops a step from history instead of adding one. */
  onStep: (review: boolean, replace?: boolean) => void;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const { ready } = useMemo(() => broadcastTemplates(templates), [templates]);
  const [templateKey, setTemplateKey] = useState(() =>
    ready.some((row) => templateId(row) === initialTemplate)
      ? (initialTemplate ?? null)
      : null,
  );
  const [phoneNumberId, setPhoneNumberId] = useState(
    phones[0]?.phoneNumberId ?? "",
  );
  const [label, setLabel] = useState("");
  const [headerLink, setHeaderLink] = useState("");
  const [table, setTable] = useState<ListTable | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  /** The frozen payload the consent box was ticked for: another payload asks again. */
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** A send got no answer: it may have started, whatever is edited afterwards. */
  const [uncertain, setUncertain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const gate = useRef<SendGate>({ phase: "idle" });

  const template = useMemo(
    () => ready.find((row) => templateId(row) === templateKey) ?? null,
    [ready, templateKey],
  );
  const sendability = useMemo(
    () => (template ? analyzeTemplate(template) : null),
    [template],
  );
  const vars = sendability?.kind === "ready" ? sendability : null;
  const slots = useMemo(() => (vars ? slotsOf(vars) : []), [vars]);
  const view = useMemo(
    () => (template ? templateView(template) : null),
    [template],
  );
  const headerMedia = vars?.headerMedia ?? null;
  const worstHeader: TemplateHeaderMedia | null = useMemo(
    () => (headerMedia ? { format: headerMedia, link: LONGEST_LINK } : null),
    [headerMedia],
  );
  const check = useMemo(
    () =>
      table && mapping ? checkList(table, mapping, slots, worstHeader) : null,
    [table, mapping, slots, worstHeader],
  );
  const sender = phones.find((phone) => phone.phoneNumberId === phoneNumberId);
  const senderLabel = sender?.displayPhoneNumber || phoneNumberId;
  const senderCountry = countryOf(sender?.displayPhoneNumber);
  const link = headerLink.trim();
  const dataRowCount =
    table && mapping ? table.rows.length - (mapping.header ? 1 : 0) : 0;

  const payload = useMemo(
    () =>
      template && check && mapping
        ? broadcastPayload({
            wabaId,
            phoneNumberId,
            templateName: template.name ?? "",
            languageCode: template.language ?? "",
            label,
            slots,
            mapping,
            check,
            headerMedia: headerMedia ? { format: headerMedia, link } : null,
          })
        : null,
    [
      template,
      check,
      mapping,
      wabaId,
      phoneNumberId,
      label,
      slots,
      headerMedia,
      link,
    ],
  );
  const json = useMemo(
    () => (payload ? JSON.stringify(payload) : null),
    [payload],
  );
  const compose = composeNote({
    blocked,
    noSender: phones.length === 0,
    hasTemplate: template !== null,
    hasList: table !== null,
    tooManyRows: dataRowCount > preflight.maxRecipients ? dataRowCount : null,
    maxRecipients: preflight.maxRecipients,
    phoneMapped: mapping?.phone != null,
    unmapped:
      slots.find((slot) => {
        const source = mapping?.sources[slot.id];
        return !source || ("fixed" in source && !source.fixed.trim());
      }) ?? null,
    headerMissing: headerMedia && !HTTPS_LINK.test(link) ? headerMedia : null,
    sendable: check?.counts.send ?? 0,
    total: check?.rows.length ?? 0,
    bytes: json ? payloadBytes(json) : 0,
    pacePerMinute: preflight.pacePerMinute,
  });

  const dirty = table !== null || label.trim() !== "";
  const leave = useBlocker(leaveBlocker(dirty));
  const review =
    reviewOpen(wantsReview, frozen?.json ?? null, json) && frozen !== null;
  // A stale `?step=review` (Back, Forward, a reload) goes, so typing back to the
  // frozen payload never flips the page to Review mid-edit.
  useEffect(() => {
    if (wantsReview && !review) onStep(false, true);
  }, [wantsReview, review, onStep]);

  function chooseTemplate(id: string) {
    setTemplateKey(id);
    setHeaderLink("");
    const row = ready.find((entry) => templateId(entry) === id);
    const next = row ? analyzeTemplate(row) : null;
    if (table && next?.kind === "ready")
      setMapping(
        autoMapping(table, slotsOf(next), mapping?.country ?? senderCountry),
      );
  }

  function choosePhone(id: string) {
    const nextCountry = countryOf(
      phones.find((phone) => phone.phoneNumberId === id)?.displayPhoneNumber,
    );
    setPhoneNumberId(id);
    // The country follows the sender until the operator picks another one.
    if (mapping && mapping.country === senderCountry)
      setMapping({ ...mapping, country: nextCountry });
  }

  function takeList(list: ListTable) {
    setTable(list);
    setMapping(autoMapping(list, slots, senderCountry));
    setPreviewIndex(0);
  }

  function downloadSkipped(list: ListTable, by: Mapping, of: ListCheck) {
    downloadCsv(`${slug(list.name ?? "list")}-skipped.csv`, skippedCsv(list, by, of));
  }

  function enterReview() {
    if (
      compose.blocker ||
      !payload ||
      !json ||
      !check ||
      !template ||
      !sendability ||
      !table ||
      !mapping
    )
      return;
    setFrozen((prev) => ({
      payload,
      json,
      key: reviewKey(prev, json, () => crypto.randomUUID()),
      check,
      template,
      sendability,
      slots,
      view,
      headerLink: link,
      sender: senderLabel,
      table,
      mapping,
    }));
    setFailure(null);
    setReviewIndex(0);
    onStep(true);
    window.scrollTo({ top: 0 });
  }

  async function send() {
    if (!frozen) return;
    await runSend(gate.current, async () => {
      setSubmitting(true);
      setFailure(null);
      try {
        const result = await createBroadcast({
          data: { ...frozen.payload, idempotencyKey: frozen.key },
        });
        if (!result.ok) {
          if (result.kind === "unreachable") setUncertain(true);
          const copy = failureCopy(result);
          setFailure({
            copy: { title: copy.title, detail: copy.detail, actions: [] },
          });
          return false;
        }
        const answer = result.data;
        if (answer.ok) {
          toast(
            `Broadcast started · ${fmtCount(answer.broadcast.total)} recipients`,
          );
          await invalidateRoutes(router, "/broadcasts");
          navigate({
            to: "/broadcasts/$broadcastId",
            params: { broadcastId: answer.broadcast.id },
            search: wabaParam ? { wabaId: wabaParam } : {},
            ignoreBlocker: true,
          });
          return true;
        }
        const sent = frozen.check.rows.filter((row) => row.state === "send");
        setFailure({
          copy: broadcastFailureCopy(answer, {
            template: `${frozen.payload.templateName} (${frozen.payload.languageCode})`,
            sender: frozen.sender,
            maxRunning: preflight.maxRunning,
          }),
          rows: answer.invalid?.map(
            (entry) =>
              `# ${sent[entry.index]?.row ?? entry.index + 1} · ${entry.error}`,
          ),
        });
        return false;
      } catch {
        setUncertain(true);
        setFailure({ copy: NO_ANSWER });
        return false;
      } finally {
        setSubmitting(false);
      }
    });
  }

  const listSearch = wabaParam ? { wabaId: wabaParam } : {};
  const earlier = uncertain ? (
    <Callout tone="warning">
      {EARLIER_ATTEMPT}{" "}
      <Link
        to="/broadcasts"
        search={listSearch}
        target="_blank"
        className="underline underline-offset-4"
      >
        Broadcasts ↗
      </Link>
    </Callout>
  ) : null;
  const back = review ? (
    <button
      type="button"
      onClick={() => onStep(false)}
      className={`inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground ${COUNT_LINK}`}
    >
      <ChevronLeftIcon aria-hidden="true" className="size-4" />
      Edit
    </button>
  ) : (
    <Link
      to="/broadcasts"
      search={listSearch}
      className={`inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground ${COUNT_LINK}`}
    >
      <ChevronLeftIcon aria-hidden="true" className="size-4" />
      Broadcasts
    </Link>
  );

  return (
    <Page
      title={review ? "Review broadcast" : "New broadcast"}
      kicker="Sending"
      actions={back}
    >
      {review && frozen ? (
        <FrozenReview
          frozen={frozen}
          preflight={preflight}
          blocked={blocked}
          consent={consentFor === frozen.json}
          onConsent={(ticked) => setConsentFor(ticked ? frozen.json : null)}
          index={reviewIndex}
          onIndex={setReviewIndex}
          submitting={submitting}
          onSend={send}
          onTest={() => setTesting(true)}
          onDownload={() => downloadSkipped(frozen.table, frozen.mapping, frozen.check)}
          notes={
            <>
              {earlier}
              <output aria-live="polite" aria-atomic="true">
                {failure ? (
                  <FailureNote
                    failure={failure}
                    template={frozen.template}
                    wabaParam={wabaParam}
                    onEdit={() => onStep(false)}
                    onRetry={send}
                    onReload={() => {
                      void router.invalidate();
                      onStep(false);
                    }}
                  />
                ) : null}
              </output>
            </>
          }
        />
      ) : (
        <div className={SPLIT_GRID}>
          <div className={`flex flex-col gap-8 ${SPLIT_MAIN}`}>
            {earlier}
            <section
              aria-labelledby="broadcast-message-title"
              className="flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1">
                <SectionHeading id="broadcast-message-title" title="Message" />
                <p className={`m-0 ${SUPPORT_TIER}`}>
                  One approved template, sent to everyone on the list.
                </p>
              </div>
              <SectionFrame flush>
                <ComposeMessage
                  wabaId={wabaParam}
                  rows={templates}
                  template={template}
                  onTemplate={chooseTemplate}
                  phones={phones}
                  phoneNumberId={phoneNumberId}
                  onPhone={choosePhone}
                  label={label}
                  onLabel={setLabel}
                  headerMedia={headerMedia}
                  headerLink={headerLink}
                  onHeaderLink={setHeaderLink}
                />
              </SectionFrame>
            </section>

            <section
              aria-labelledby="broadcast-recipients-title"
              className="flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1">
                <SectionHeading
                  id="broadcast-recipients-title"
                  title="Recipients"
                />
                <p className={`m-0 ${SUPPORT_TIER}`}>
                  One row per person. Up to {fmtCount(preflight.maxRecipients)}{" "}
                  rows.
                </p>
              </div>
              <SectionFrame flush>
                {table && mapping && check ? (
                  <ColumnMapping
                    table={table}
                    slots={slots}
                    mapping={mapping}
                    check={check}
                    onMapping={setMapping}
                    onReplace={() => {
                      setTable(null);
                      setMapping(null);
                    }}
                  />
                ) : (
                  <ListInput
                    maxRows={preflight.maxRecipients}
                    onList={takeList}
                    onExample={
                      template
                        ? () =>
                            downloadCsv(
                              `${template.name}-example.csv`,
                              exampleCsv(slots),
                            )
                        : undefined
                    }
                  />
                )}
              </SectionFrame>
              {check && check.rows.length > 0 ? (
                <RecipientTable
                  slots={slots}
                  check={check}
                  previewRow={check.rows[previewIndex]?.row ?? null}
                  onPreview={(row) => setPreviewIndex(row - 1)}
                  onDownload={() => table && mapping && downloadSkipped(table, mapping, check)}
                />
              ) : null}
            </section>

            <ActionBar
              note={
                compose.blocker ? (
                  compose.note
                ) : (
                  <>
                    <span className="text-foreground">{compose.note}</span>
                    <br />
                    Nothing is sent until you confirm on the next step.
                  </>
                )
              }
            >
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  navigate({ to: "/broadcasts", search: listSearch })
                }
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={Boolean(compose.blocker)}
                onClick={enterReview}
              >
                Review broadcast
              </Button>
            </ActionBar>
          </div>
          <aside
            className="flex flex-col gap-6 lg:sticky lg:top-4"
            aria-label="Preview"
          >
            <RowPreview
              noun="Row"
              rows={check?.rows ?? []}
              index={previewIndex}
              onIndex={setPreviewIndex}
              slots={slots}
              view={view}
              businessName={senderLabel || "Your business"}
              headerImageUrl={
                headerMedia === "image" && HTTPS_LINK.test(link) ? link : null
              }
            />
          </aside>
        </div>
      )}

      {leave.status === "blocked" ? (
        <DiscardDraftDialog
          submitting={submitting}
          editing={false}
          onKeep={leave.reset}
          onDiscard={leave.proceed}
          copy={{
            title: "Discard this broadcast?",
            description: submitting
              ? "This broadcast is still being started. Leaving now abandons Eccos' answer; it may already be running."
              : "Nothing has been sent. The list is not saved anywhere.",
          }}
        />
      ) : null}

      {testing && review && frozen ? (
        <FrozenTestSheet
          frozen={frozen}
          wabaId={wabaId}
          phones={phones}
          index={reviewIndex}
          onClose={() => setTesting(false)}
        />
      ) : null}
    </Page>
  );
}

/** Review, read only from what it froze: the counts full width, then the facts beside the preview. */
function FrozenReview({
  frozen,
  preflight,
  blocked,
  consent,
  onConsent,
  index,
  onIndex,
  submitting,
  onSend,
  onTest,
  onDownload,
  notes,
}: {
  frozen: Frozen;
  preflight: BroadcastPreflight;
  blocked: string | null;
  consent: boolean;
  onConsent: (ticked: boolean) => void;
  index: number;
  onIndex: (index: number) => void;
  submitting: boolean;
  onSend: () => void;
  onTest: () => void;
  onDownload: () => void;
  notes: ReactNode;
}) {
  const marketing = frozen.template.category?.toUpperCase() === "MARKETING";
  const rows = frozen.check.rows.filter((row) => row.state === "send");
  const link = frozen.headerLink;
  return (
    <div className="flex max-w-[80rem] flex-col gap-8">
      <ReviewFacts
        check={frozen.check}
        pacePerMinute={preflight.pacePerMinute}
        onDownload={onDownload}
      />
      <div className={SPLIT_GRID}>
        <div className={`flex flex-col gap-8 ${SPLIT_MAIN}`}>
          <BroadcastReview
            check={frozen.check}
            label={frozen.payload.label ?? ""}
            templateName={frozen.payload.templateName}
            language={frozen.payload.languageCode}
            category={frozen.template.category}
            sender={frozen.sender}
            running={{ now: preflight.running, max: preflight.maxRunning }}
            consent={marketing ? consent : null}
            onConsent={onConsent}
          />
          {notes}
          <ActionBar
            note={
              blocked ??
              (marketing && !consent ? "Tick the consent box to send." : "")
            }
          >
            <Button
              type="button"
              variant="outline"
              disabled={submitting || rows.length === 0}
              onClick={onTest}
            >
              Send a test first
            </Button>
            <Button
              type="button"
              aria-busy={submitting}
              disabled={
                Boolean(blocked) || (marketing && !consent) || submitting
              }
              onClick={onSend}
            >
              {submitting
                ? "Starting…"
                : `Send to ${fmtCount(frozen.payload.recipients.length)} recipients`}
            </Button>
          </ActionBar>
        </div>
        <aside
          className="flex flex-col gap-6 lg:sticky lg:top-4"
          aria-label="Preview"
        >
          <RowPreview
            noun="Recipient"
            rows={rows}
            index={index}
            onIndex={onIndex}
            slots={frozen.slots}
            view={frozen.view}
            businessName={frozen.sender || "Your business"}
            headerImageUrl={
              frozen.payload.headerMedia?.format === "image" &&
              HTTPS_LINK.test(link)
                ? link
                : null
            }
          />
        </aside>
      </div>
    </div>
  );
}

/** "Send a test first": the frozen template, filled from the previewed recipient; the operator types their own number. */
function FrozenTestSheet({
  frozen,
  wabaId,
  phones,
  index,
  onClose,
}: {
  frozen: Frozen;
  wabaId: string;
  phones: SendTestPhone[];
  index: number;
  onClose: () => void;
}) {
  const row = frozen.check.rows.filter((entry) => entry.state === "send")[
    index
  ];
  if (!row) return null;
  return (
    <SendTestSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      wabaId={wabaId}
      templateName={frozen.payload.templateName}
      languageCode={frozen.payload.languageCode}
      status={frozen.template.status}
      sendability={frozen.sendability}
      phones={phones}
      initialPhoneNumberId={frozen.payload.phoneNumberId}
      view={frozen.view}
      initial={{
        params: rowValues(frozen.slots, row),
        buttons: frozen.slots.flatMap((slot, i) =>
          slot.kind === "button" ? [row.values[i] ?? ""] : [],
        ),
        headerLink: frozen.headerLink,
      }}
    />
  );
}

/** The sticky bar under the fields: why the primary waits, or what it will do, beside it. */
function ActionBar({
  note,
  children,
}: { note: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-4 border-t border-(--line) bg-background py-4">
      <p className="m-0 min-w-0 flex-1 text-sm text-pretty text-muted-foreground">
        {note}
      </p>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function FailureNote({
  failure,
  template,
  wabaParam,
  onEdit,
  onRetry,
  onReload,
}: {
  failure: Failure;
  template: TemplateRecord;
  wabaParam?: string;
  onEdit: () => void;
  onRetry: () => void;
  onReload: () => void;
}) {
  const { copy, rows } = failure;
  const action = "text-sm text-foreground underline underline-offset-4";
  return (
    <Callout tone="error">
      <p className="m-0">{copy.title}</p>
      {copy.detail ? (
        <p className="m-0 mt-1 font-mono text-xs break-words text-muted-foreground">
          {copy.detail}
        </p>
      ) : null}
      {rows && rows.length > 0 ? (
        <ul className="m-0 mt-1 list-none p-0 font-mono text-xs text-muted-foreground">
          {rows.slice(0, 10).map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      ) : null}
      {copy.actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-4">
          {copy.actions.map((kind) => {
            switch (kind) {
              case "edit":
                return (
                  <button
                    key={kind}
                    type="button"
                    className={action}
                    onClick={onEdit}
                  >
                    Back to edit
                  </button>
                );
              case "retry":
                return (
                  <button
                    key={kind}
                    type="button"
                    className={action}
                    onClick={onRetry}
                  >
                    Try again
                  </button>
                );
              case "reload":
                return (
                  <button
                    key={kind}
                    type="button"
                    className={action}
                    onClick={onReload}
                  >
                    Reload the template
                  </button>
                );
              case "broadcasts":
                return (
                  <Link
                    key={kind}
                    to="/broadcasts"
                    search={wabaParam ? { wabaId: wabaParam } : {}}
                    target="_blank"
                    className={action}
                  >
                    View broadcasts ↗
                  </Link>
                );
              case "template":
                return (
                  <Link
                    key={kind}
                    to="/templates/$name"
                    params={{ name: template.name ?? "" }}
                    search={{ wabaId: wabaParam, language: template.language }}
                    target="_blank"
                    className={action}
                  >
                    Open template ↗
                  </Link>
                );
            }
          })}
        </div>
      ) : null}
    </Callout>
  );
}
