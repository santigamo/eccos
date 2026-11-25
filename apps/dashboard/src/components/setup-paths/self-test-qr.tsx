import { CopyIcon } from "lucide-react";
import { waLink } from "../../lib/setup-test";
import { CopyButton } from "../dashboard/copy-button";
import { QrCode } from "../dashboard/qr-code";

/** The small underlined Copy used across the setup paths. */
export const COPY_LINK = "h-auto gap-1.5 px-0 py-0 text-xs font-medium text-foreground underline decoration-1 underline-offset-3";

export function CopyLink({ value, label = "Copy" }: { value: string; label?: string }) {
  return (
    <CopyButton
      value={value}
      label={label}
      icon={<CopyIcon aria-hidden="true" className="size-3" />}
      variant="link"
      className={COPY_LINK}
    />
  );
}

/** The self-test's left column: a code that opens WhatsApp with the test message typed, and the number to type by hand. */
export function SelfTestQr({ phone, footnote }: { phone: string; footnote?: string }) {
  return (
    <div className="flex w-full shrink-0 flex-col gap-3 sm:w-49">
      <QrCode value={waLink(phone)} label={`QR code that opens a WhatsApp chat with ${phone}`} />
      <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">
        Point any phone's camera here. WhatsApp opens with the message ready. Tap send.
      </p>
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <p className="m-0 text-[11px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">
          Or type it yourself
        </p>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs leading-5 text-foreground">{phone}</span>
          <CopyLink value={phone} />
        </div>
      </div>
      {footnote ? <p className="m-0 text-[13px] leading-4.5 text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}

export const OTHER_PHONE = "Use a different phone than the one that has this number.";
