import { Link } from "@tanstack/react-router";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TemplateHeaderMediaFormat } from "@eccos/gateway-contract";
import { broadcastTemplates, templateId } from "../../lib/broadcast-draft";
import { languageLabel } from "../../lib/template-languages";
import { categoryLabel, qualityReading, type TemplateRecord } from "../../lib/template-view";
import { COUNT_LINK, StatusTag } from "../../ui";
import { SECONDARY_TIER } from "../dashboard/plain-table";
import { Row, Rows } from "../dashboard/settings-section";
import type { SendTestPhone } from "../templates/send-test-sheet";

const optionLabel = (row: TemplateRecord) => `${row.name} · ${languageLabel(row.language ?? "")} ${row.language ?? ""}`;

/** The message half of compose: the template, the sending number, the team's name for it, and a header link when the template has one. */
export function ComposeMessage({
  wabaId,
  rows,
  template,
  onTemplate,
  phones,
  phoneNumberId,
  onPhone,
  label,
  onLabel,
  headerMedia,
  headerLink,
  onHeaderLink,
}: {
  wabaId?: string;
  rows: TemplateRecord[];
  template: TemplateRecord | null;
  onTemplate: (id: string) => void;
  phones: SendTestPhone[];
  phoneNumberId: string;
  onPhone: (id: string) => void;
  label: string;
  onLabel: (label: string) => void;
  headerMedia: TemplateHeaderMediaFormat | null;
  headerLink: string;
  onHeaderLink: (link: string) => void;
}) {
  const { ready, unavailable, others } = broadcastTemplates(rows);
  const quality = template ? qualityReading(template) : null;

  if (ready.length === 0 && unavailable.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 p-5">
        <p className="m-0 text-sm text-muted-foreground">A broadcast needs a template Meta has approved. You have none yet.</p>
        <Link to="/templates/new" search={{ wabaId }} className={`text-sm text-foreground underline underline-offset-4`}>
          New template
        </Link>
      </div>
    );
  }

  return (
    <Rows>
      <Row label="Template">
        <span className="flex flex-col gap-2 py-1">
          <span className="flex flex-wrap items-center gap-3">
            <Select value={template ? templateId(template) : ""} onValueChange={(id) => id && onTemplate(id)}>
              <SelectTrigger aria-label="Template" className="w-80 max-w-full rounded-none font-mono">
                <SelectValue>{() => (template ? optionLabel(template) : "Choose a template")}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                {ready.map((row) => (
                  <SelectItem key={templateId(row)} value={templateId(row)} className="font-mono">
                    {optionLabel(row)}
                  </SelectItem>
                ))}
                {unavailable.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Not available here</SelectLabel>
                    {unavailable.map(({ row, reason }) => (
                      <SelectItem key={templateId(row)} value={templateId(row)} disabled>
                        <span className="flex flex-col">
                          <span className="font-mono">{optionLabel(row)}</span>
                          <span className={SECONDARY_TIER}>{reason}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
            {template ? (
              <>
                <StatusTag status={categoryLabel(template.category)} />
                <Link
                  to="/templates/$name"
                  params={{ name: template.name ?? "" }}
                  search={{ wabaId, language: template.language }}
                  target="_blank"
                  className={`text-sm font-normal text-muted-foreground underline ${COUNT_LINK} hover:text-foreground`}
                >
                  Open template ↗
                </Link>
              </>
            ) : null}
          </span>
          <span className={`font-normal ${SECONDARY_TIER}`}>
            Only templates Meta has approved are listed.
            {others > 0 ? ` ${others} ${others === 1 ? "other is" : "others are"} in review or rejected.` : ""}
          </span>
          {quality && quality.tone !== "neutral" ? (
            <Callout tone="warning">
              Meta rates this template's quality as {quality.label}. Sending it to a list can get it paused, which stops the broadcast.
            </Callout>
          ) : null}
        </span>
      </Row>
      <Row label="From">
        {phones.length > 1 ? (
          <Select value={phoneNumberId} onValueChange={(id) => id && onPhone(id)}>
            <SelectTrigger aria-label="From" className="w-64 rounded-none font-mono">
              <SelectValue>{(id: string) => phones.find((phone) => phone.phoneNumberId === id)?.displayPhoneNumber || id}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {phones.map((phone) => (
                <SelectItem key={phone.phoneNumberId} value={phone.phoneNumberId} className="font-mono">
                  {phone.displayPhoneNumber || phone.phoneNumberId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="font-mono text-sm font-normal">{phones[0]?.displayPhoneNumber || phones[0]?.phoneNumberId || "—"}</span>
        )}
      </Row>
      <Row label="Name">
        <span className="flex flex-wrap items-center gap-3">
          <Input
            aria-label="Name"
            className="w-80 max-w-full font-normal"
            maxLength={80}
            value={label}
            placeholder="Friday pickups"
            onChange={(event) => onLabel(event.target.value)}
          />
          <span className={`font-normal ${SECONDARY_TIER}`}>Optional. Only your team sees it.</span>
        </span>
      </Row>
      {headerMedia ? (
        <Row label={`${headerMedia} header`}>
          <span className="flex flex-col gap-1.5 py-1">
            <Input
              aria-label={`${headerMedia} header link`}
              type="url"
              inputMode="url"
              className="w-80 max-w-full font-normal"
              value={headerLink}
              placeholder="https://…"
              onChange={(event) => onHeaderLink(event.target.value)}
            />
            <span className={`font-normal ${SECONDARY_TIER}`}>
              A public link to the {headerMedia}. Meta fetches it when each message is sent. Everyone gets the same one.
            </span>
          </span>
        </Row>
      ) : null}
    </Rows>
  );
}
