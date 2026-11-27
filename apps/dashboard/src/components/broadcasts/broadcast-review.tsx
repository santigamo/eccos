import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { estimateMinutes, fmtMinutes } from "../../lib/broadcast-draft";
import { type ListCheck, skippedCount } from "../../lib/recipient-list";
import { categoryLabel } from "../../lib/template-view";
import { FactCell, FactsStrip, fmtCount, StatusTag } from "../../ui";
import {
  IDENTITY_TIER,
  SectionHeading,
  SUPPORT_TIER,
} from "../dashboard/plain-table";
import { Row, Rows, SectionFrame } from "../dashboard/settings-section";

const META_LIMITS =
  "https://developers.facebook.com/docs/whatsapp/messaging-limits";
const META_PRICING = "https://developers.facebook.com/docs/whatsapp/pricing";
/** Past this many recipients Meta's 24-hour messaging limit can bite a new account. */
const LIMIT_NOTE_FROM = 250;

const plural = (n: number, one: string, many: string) =>
  `${fmtCount(n)} ${n === 1 ? one : many}`;

function ExternalLink({
  href,
  children,
}: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline underline-offset-4"
    >
      {children} ↗
    </a>
  );
}

/** The counts the console derived, full width above the review's two columns. */
export function ReviewFacts({
  check,
  pacePerMinute,
  onDownload,
}: {
  check: ListCheck;
  pacePerMinute: number;
  onDownload: () => void;
}) {
  const recipients = check.counts.send;
  const skipped = skippedCount(check);
  const minutes = estimateMinutes(recipients, pacePerMinute);
  const doneAt = new Date(Date.now() + minutes * 60_000).toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit" },
  );
  const reasons = [
    check.counts.duplicate
      ? plural(check.counts.duplicate, "duplicate", "duplicates")
      : null,
    check.counts.invalid
      ? plural(check.counts.invalid, "invalid number", "invalid numbers")
      : null,
    check.counts.missing
      ? plural(check.counts.missing, "missing value", "missing values")
      : null,
    check.counts.too_long
      ? plural(check.counts.too_long, "value too long", "values too long")
      : null,
  ].filter(Boolean);

  return (
    <FactsStrip label="Broadcast summary">
      <FactCell
        kicker="Recipients"
        value={fmtCount(recipients)}
        caption={`of the ${fmtCount(check.rows.length)} rows in your list`}
      />
      <FactCell
        kicker="Skipped"
        value={fmtCount(skipped)}
        caption={
          skipped === 0 ? "every row will be sent" : `${reasons.join(" · ")}`
        }
      >
        {skipped > 0 ? (
          <button
            type="button"
            onClick={onDownload}
            className="text-sm text-foreground underline underline-offset-4"
          >
            Download CSV
          </button>
        ) : null}
      </FactCell>
      <FactCell
        kicker="Estimated time"
        value={fmtMinutes(minutes)}
        caption={`at ${fmtCount(pacePerMinute)} a minute · done around ${doneAt}, later if Meta slows it down`}
      />
    </FactsStrip>
  );
}

/**
 * What the operator confirms beside the preview: the message's facts with each
 * caveat beside the fact it qualifies, and, for a marketing template, the
 * consent Meta's policy asks of them.
 */
export function BroadcastReview({
  check,
  label,
  templateName,
  language,
  category,
  sender,
  running,
  consent,
  onConsent,
}: {
  check: ListCheck;
  label: string;
  templateName: string;
  language: string;
  category: string | undefined;
  sender: string;
  /** Broadcasts already running and the most that may, from the preflight. */
  running: { now: number; max: number };
  /** Null for a template that needs none (utility). */
  consent: boolean | null;
  onConsent: (consent: boolean) => void;
}) {
  const recipients = check.counts.send;
  return (
    <div className="flex flex-col gap-8">
      <section
        aria-labelledby="review-message-title"
        className="flex flex-col gap-3"
      >
        <SectionHeading id="review-message-title" title="What will be sent" />
        <SectionFrame flush>
          <Rows>
            {label.trim() ? <Row label="Name">{label.trim()}</Row> : null}
            <Row label="Template">
              <span className="inline-flex items-center gap-3">
                <span className="font-mono">
                  {templateName} · {language}
                </span>
                {category ? (
                  <StatusTag status={categoryLabel(category)} />
                ) : null}
              </span>
            </Row>
            <Row label="From">
              <span className="font-mono">{sender}</span>
            </Row>
            <Row label="Starts">
              <span className="flex flex-col gap-0.5 py-1">
                <span>As soon as you confirm</span>
                <span className={`font-normal ${SUPPORT_TIER}`}>
                  Sent messages cannot be recalled. You can cancel the rest
                  while it runs.
                </span>
                {running.now >= running.max ? (
                  <span className="text-sm font-normal text-warning-foreground">
                    {fmtCount(running.now)} broadcasts are already running on
                    this WhatsApp Business Account, the most at once: this one
                    is refused until one of them ends.
                  </span>
                ) : null}
              </span>
            </Row>
            {check.cleaned > 0 ? (
              <Row label="Values">
                <span className={`block py-1 font-normal ${SUPPORT_TIER}`}>
                  {plural(check.cleaned, "cell has", "cells have")} line breaks,
                  tabs or long runs of spaces, which Meta refuses: they are sent
                  as one space.
                </span>
              </Row>
            ) : null}
            {recipients > LIMIT_NOTE_FROM ? (
              <Row label="Meta's limit">
                <span className={`block py-1 font-normal ${SUPPORT_TIER}`}>
                  Meta caps how many people a business can message in 24 hours.
                  Past your limit it refuses the rest, and they show here as
                  failed.{" "}
                  <ExternalLink href={META_LIMITS}>
                    Check your limit in WhatsApp Manager
                  </ExternalLink>
                </span>
              </Row>
            ) : null}
            <Row label="Cost">
              <span className={`block py-1 font-normal ${SUPPORT_TIER}`}>
                Eccos charges nothing per message. Meta bills each delivered
                message to your WhatsApp Business Account.{" "}
                <ExternalLink href={META_PRICING}>Meta's pricing</ExternalLink>
              </span>
            </Row>
          </Rows>
        </SectionFrame>
      </section>

      {consent !== null ? (
        <section
          aria-labelledby="review-consent-title"
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <SectionHeading id="review-consent-title" title="Consent" />
            <p className={`m-0 ${SUPPORT_TIER}`}>
              Asked because this is a marketing template.
            </p>
          </div>
          <SectionFrame flush>
            <div className="flex flex-col gap-2 border-b border-(--line) px-5 py-4 text-sm text-foreground">
              <p className="m-0">
                Meta allows marketing messages only to people who agreed to
                receive them. Blocks and reports lower this number's quality
                rating and can pause the template.
              </p>
              <p className="m-0">
                Eccos keeps no opt-out list: remove anyone who asked you to stop
                before you send.
              </p>
            </div>
            <div className="flex items-center gap-3 px-5 py-4">
              <Checkbox
                id="broadcast-consent"
                checked={consent}
                onCheckedChange={(value) => onConsent(value === true)}
              />
              <label
                htmlFor="broadcast-consent"
                className={`cursor-pointer ${IDENTITY_TIER}`}
              >
                Everyone on this list agreed to receive WhatsApp messages from
                us.
              </label>
            </div>
          </SectionFrame>
        </section>
      ) : null}
    </div>
  );
}
