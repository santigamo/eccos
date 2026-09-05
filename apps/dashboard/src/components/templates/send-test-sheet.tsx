import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { sendTemplateTest } from "../../server/gateway";
import type { SendTemplateTestResult } from "../../server/gateway";
import { failureCopy, sendTestFailureCopy } from "../../lib/failure";
import { previewBody, type TemplateSendability } from "../../lib/template-params";
import type { ButtonUrlParam } from "@eccos/gateway-contract";
import { StatusTag } from "../../ui";

export interface SendTestPhone {
  phoneNumberId: string;
  displayPhoneNumber: string;
}

interface SendTestFormProps {
  wabaId: string;
  templateName: string;
  languageCode: string;
  sendability: TemplateSendability;
  phones: SendTestPhone[];
}

type Notice =
  | { ok: true; messageId: string }
  | { ok: false; title: string; detail: string; secondary?: string };

const LABEL = "mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

/**
 * "Send test" — one template message from the console, to prove a template
 * renders on a real handset (and, for Meta App Review, to have something to
 * film).
 *
 * The form is exported on its own because the sheet around it is a Base UI
 * dialog: closed, it renders nothing at all, so a static-markup test of
 * `SendTestSheet` would assert against an empty string. Tests render this.
 */
export function SendTestForm({
  wabaId,
  templateName,
  languageCode,
  sendability,
  phones,
}: SendTestFormProps) {
  const paramCount = sendability.kind === "ready" ? sendability.paramCount : 0;
  const [phoneNumberId, setPhoneNumberId] = useState(phones[0]?.phoneNumberId ?? "");
  const [recipient, setRecipient] = useState("");
  const [params, setParams] = useState<string[]>(() => Array.from({ length: paramCount }, () => ""));
  const buttonSlots = sendability.kind === "ready" ? sendability.buttons : [];
  const [buttonParams, setButtonParams] = useState<ButtonUrlParam[]>(() =>
    buttonSlots.map((slot) => ({ index: slot.index, text: "" })),
  );
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  function setParam(index: number, value: string) {
    setParams((current) => current.map((entry, i) => (i === index ? value : entry)));
  }

  function setButtonParam(index: number, value: string) {
    setButtonParams((current) =>
      current.map((entry, i) => (i === index ? { ...entry, text: value } : entry)),
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setNotice(null);
    try {
      const result = await sendTemplateTest({
        data: {
          wabaId,
          phoneNumberId,
          to: recipient,
          templateName,
          languageCode,
          ...(params.length > 0 ? { bodyParams: params } : {}),
        },
      });
      if (!result.ok) {
        // A boundary failure (unreachable / unauthenticated / forbidden) is a
        // different class from a refused send, and keeps its own mapping.
        const copy = failureCopy(result);
        setNotice({ ok: false, title: copy.title, detail: copy.detail });
        return;
      }
      setNotice(noticeFor(result.data));
    } finally {
      setSending(false);
    }
  }

  if (sendability.kind === "unsupported") {
    // The row's button still opens the sheet, because "why can I not send this
    // one?" is the question an operator actually has. What it does not get is a
    // button that would fail at Meta (data rule 5: no dead buttons).
    return (
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
          {sendability.reason}
        </p>
      </div>
    );
  }

  const preview = sendability.bodyText ? previewBody(sendability.bodyText, params) : null;

  return (
    <form onSubmit={onSubmit} aria-busy={sending} className="flex flex-col gap-4 px-4 pb-4">
      <div>
        <span className={LABEL}>From</span>
        {phones.length === 1 ? (
          <p className="m-0 font-mono text-xs text-foreground">
            {phones[0]?.displayPhoneNumber || "—"}
            <span className="text-muted-foreground"> {"·"} {phones[0]?.phoneNumberId}</span>
          </p>
        ) : (
          <Select value={phoneNumberId} onValueChange={(value) => setPhoneNumberId(value ?? "")}>
            <SelectTrigger id="send-test-from" size="sm" className="w-full rounded-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-(--anchor-width)">
              {phones.map((phone) => (
                <SelectItem key={phone.phoneNumberId} value={phone.phoneNumberId}>
                  {phone.displayPhoneNumber || phone.phoneNumberId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div>
        <label htmlFor="send-test-recipient" className={LABEL}>
          Recipient
        </label>
        <Input
          id="send-test-recipient"
          type="tel"
          required
          inputMode="tel"
          autoComplete="off"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          placeholder="+34 600 00 00 11"
        />
        <p className="mt-1 m-0 max-w-prose text-xs text-pretty text-muted-foreground">
          With a Cloud API test number, only recipients on its allowed list can receive messages.
        </p>
      </div>

      {params.map((value, index) => (
        // Positional parameters have no names, so the index IS the identity —
        // the list never reorders and its length is fixed by the template.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional by definition
        <div key={index}>
          <label htmlFor={`send-test-param-${index + 1}`} className={LABEL}>
            {`{{${index + 1}}}`}
          </label>
          <Input
            id={`send-test-param-${index + 1}`}
            required
            autoComplete="off"
            value={value}
            onChange={(event) => setParam(index, event.target.value)}
          />
        </div>
      ))}

      {buttonSlots.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose text-xs text-pretty text-muted-foreground">Button links</p>
          {buttonSlots.map((slot, index) => (
            <div key={slot.index}>
              <label htmlFor={`send-test-button-${slot.index}`} className={LABEL}>
                Button {slot.index + 1}
              </label>
              <Input
                id={`send-test-button-${slot.index}`}
                required
                autoComplete="off"
                value={buttonParams[index]?.text ?? ""}
                onChange={(event) => setButtonParam(index, event.target.value)}
                placeholder={slot.urlPrefix}
              />
            </div>
          ))}
        </div>
      ) : null}

      {preview ? (
        <div>
          <span className={LABEL}>Preview</span>
          {/* Quiet and inert: `--ghost-fill` is the ghost CONTROL body, and a
              preview that wore it would read as something to click. */}
          <p className="m-0 border border-(--line) bg-muted p-3 text-sm whitespace-pre-wrap text-foreground">
            {preview}
          </p>
        </div>
      ) : null}

      <Button type="submit" className="w-fit self-start" aria-busy={sending} disabled={sending}>
        {sending ? "Sending…" : "Send test message"}
      </Button>

      {/* Mounted even when empty: a live region that appears with its message is
          not reliably announced, one that fills up is. */}
      <output
        aria-live="polite"
        aria-atomic="true"
        className={notice ? "block border-l-2 border-l-(--line-strong) px-3 py-2" : undefined}
      >
        {notice ? <NoticeBody notice={notice} wabaId={wabaId} /> : null}
      </output>
    </form>
  );
}

/** Per-code copy, never a raw Graph payload. */
function noticeFor(result: SendTemplateTestResult): Notice {
  if (result.ok) return { ok: true, messageId: result.messageId };
  const copy = sendTestFailureCopy(result.code, result.detail);
  return {
    ok: false,
    title: copy.title,
    detail: copy.detail,
    // Meta's own sentence explains; it never discriminates, so it sits under
    // the console's words as a secondary line and only when it adds something.
    ...(result.code === "graph" && result.detail ? { secondary: result.detail } : {}),
  };
}

function NoticeBody({ notice, wabaId }: { notice: Notice; wabaId: string }) {
  if (notice.ok) {
    return (
      <span className="block text-sm text-foreground">
        <span className="font-mono text-xs">
          Sent {"·"} {notice.messageId}
        </span>{" "}
        {/* Data rule 2: the result links to the row that evidences it. */}
        <Link to="/outbound" search={{ wabaId }} className="underline underline-offset-4">
          View in outbound
        </Link>
      </span>
    );
  }
  return (
    <span className="block">
      <span className="block text-sm text-[#ff7777]">{notice.title}</span>
      <span className="block text-sm text-muted-foreground">{notice.detail}</span>
      {notice.secondary ? (
        <span className="mt-1 block font-mono text-xs break-words text-muted-foreground">
          {notice.secondary}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The sheet around the form.
 *
 * The title lives here rather than in `SendTestForm` because Base UI's
 * `Dialog.Title` needs the dialog context — which is also why the form is what
 * the tests render.
 */
export function SendTestSheet({
  open,
  onOpenChange,
  templateName,
  languageCode,
  status,
  sendability,
  phones,
  wabaId,
}: SendTestFormProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: string | undefined;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-2">
          <SheetTitle className="font-mono text-sm break-all">
            {templateName} {"·"} {languageCode}
          </SheetTitle>
          {status ? (
            <span className="w-fit">
              <StatusTag status={status.toLowerCase()} />
            </span>
          ) : null}
        </SheetHeader>
        <SendTestForm
          wabaId={wabaId}
          templateName={templateName}
          languageCode={languageCode}
          sendability={sendability}
          phones={phones}
        />
      </SheetContent>
    </Sheet>
  );
}
