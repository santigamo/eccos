import { useEffect, useState, type ReactNode } from "react";
import {
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ImageIcon,
  ListIcon,
  MapPinIcon,
  PhoneIcon,
  PlayIcon,
  ReplyIcon,
  StoreIcon,
} from "lucide-react";
import { parseWhatsApp, type WaNode } from "../../lib/whatsapp-format";
import type { ButtonKind, TemplateHeader } from "../../lib/template-view";

/**
 * A template as the customer's phone shows it: WhatsApp's dark chat, the
 * business's name in the bar, one incoming bubble with its header, formatted
 * body, footer, time and buttons.
 *
 * It depicts another product, so it wears that product's shapes and colours
 * (`--wa-*`): the rounded bubble is WhatsApp's, not the console's. The frame
 * around it stays square.
 */

export interface PreviewButton {
  kind: ButtonKind;
  text: string;
}

export interface WhatsAppPreviewProps {
  businessName: string;
  header: TemplateHeader | null;
  headerValues?: Record<string, string>;
  body: string;
  bodyValues?: Record<string, string>;
  footer?: string;
  buttons?: PreviewButton[];
  /** Tint filled placeholders, so example values read apart from the copy. */
  markValues?: boolean;
  /** Replaces the header's stored example image (a link typed for a send). */
  headerImageUrl?: string | null;
}

const BUTTON_ICONS: Record<ButtonKind, typeof ExternalLinkIcon> = {
  url: ExternalLinkIcon,
  phone: PhoneIcon,
  quick_reply: ReplyIcon,
  copy_code: CopyIcon,
  otp: CopyIcon,
  flow: ListIcon,
  other: ReplyIcon,
};

/** WhatsApp shows three buttons at most; past that, two and "See all options". */
function visibleButtons(buttons: PreviewButton[]): PreviewButton[] {
  return buttons.length > 3
    ? [...buttons.slice(0, 2), { kind: "flow", text: "See all options" }]
    : buttons;
}

/** Reserves room at the end of the last line for the time, as WhatsApp does. */
const TIME_SPACER = <span aria-hidden="true" className="inline-block w-11" />;

function useClock(): string {
  const [time, setTime] = useState("");
  useEffect(() => {
    setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }, []);
  return time;
}

function WaText({
  nodes,
  values,
  markValues,
}: {
  nodes: WaNode[];
  values: Record<string, string>;
  markValues: boolean;
}): ReactNode {
  return nodes.map((node, index) => {
    const key = index;
    switch (node.kind) {
      case "text":
        return node.text;
      case "var": {
        const value = values[node.key];
        if (!value) {
          return (
            <span key={key} className="text-(--wa-link)">
              {`{{${node.key}}}`}
            </span>
          );
        }
        return markValues ? (
          <span key={key} className="rounded-[3px] bg-(--wa-link)/15 px-0.5">
            {value}
          </span>
        ) : (
          value
        );
      }
      case "bold":
        return (
          <strong key={key} className="font-bold">
            <WaText nodes={node.children} values={values} markValues={markValues} />
          </strong>
        );
      case "italic":
        return (
          <em key={key}>
            <WaText nodes={node.children} values={values} markValues={markValues} />
          </em>
        );
      case "strike":
        return (
          <s key={key}>
            <WaText nodes={node.children} values={values} markValues={markValues} />
          </s>
        );
      case "mono":
        return (
          <code key={key} className="font-mono text-[0.92em]">
            <WaText nodes={node.children} values={values} markValues={markValues} />
          </code>
        );
    }
  });
}

function MediaHeader({ header, imageUrl }: { header: TemplateHeader; imageUrl?: string | null }) {
  const [broken, setBroken] = useState(false);
  if (header.format === "TEXT") return null;
  const src = imageUrl ?? header.exampleUrl;
  if (header.format === "IMAGE" && src && !broken) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="aspect-[1.91/1] w-full rounded-[6px] object-cover"
      />
    );
  }
  if (header.format === "DOCUMENT") {
    return (
      <div className="flex items-center gap-3 rounded-[6px] bg-(--wa-media) px-3 py-3 text-(--wa-ink)">
        <FileTextIcon aria-hidden="true" className="size-7 shrink-0 text-(--wa-muted)" />
        <span className="min-w-0">
          <span className="block truncate text-[13px]">Document</span>
          <span className="block text-[11px] text-(--wa-muted)">PDF</span>
        </span>
      </div>
    );
  }
  const Icon = header.format === "VIDEO" ? PlayIcon : header.format === "LOCATION" ? MapPinIcon : ImageIcon;
  return (
    <div className="flex aspect-[1.91/1] w-full items-center justify-center rounded-[6px] bg-(--wa-media)">
      <span className="flex size-11 items-center justify-center rounded-[50%] bg-black/35">
        <Icon aria-hidden="true" className="size-5 text-(--wa-ink)" />
      </span>
    </div>
  );
}

export function WhatsAppPreview({
  businessName,
  header,
  headerValues = {},
  body,
  bodyValues = {},
  footer,
  buttons = [],
  markValues = false,
  headerImageUrl,
}: WhatsAppPreviewProps) {
  const time = useClock();
  const shown = visibleButtons(buttons);

  return (
    <figure
      aria-label="Preview as the customer sees it in WhatsApp"
      className="m-0 flex flex-col overflow-hidden border border-(--line) bg-(--wa-wall)"
    >
      <figcaption className="flex items-center gap-2.5 bg-(--wa-bar) px-3 py-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[50%] bg-[#6a7175]">
          <StoreIcon aria-hidden="true" className="size-4 text-(--wa-ink)" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] text-(--wa-ink)">{businessName}</span>
          <span className="block text-[11px] text-(--wa-muted)">Business account</span>
        </span>
      </figcaption>

      <div className="flex flex-col items-start gap-2 px-3 pt-3 pb-5">
        <span className="self-center rounded-[6px] bg-(--wa-chip) px-2 py-1 text-[11px] text-(--wa-muted) uppercase">
          Today
        </span>
        <div className="relative w-full max-w-[19rem] rounded-[7.5px] rounded-tl-none bg-(--wa-bubble) text-(--wa-ink) shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
          <svg
            aria-hidden="true"
            viewBox="0 0 8 13"
            className="absolute top-0 -left-2 h-[13px] w-2 fill-(--wa-bubble)"
          >
            <path d="M8 0H0l8 13z" />
          </svg>
          {header && header.format !== "TEXT" ? (
            <div className="p-[3px] pb-0">
              <MediaHeader header={header} imageUrl={headerImageUrl} />
            </div>
          ) : null}
          <div className="relative px-2 pt-1.5 pb-2 text-[14px] leading-[19px] break-words whitespace-pre-wrap">
            {header?.format === "TEXT" && header.text ? (
              <p className="m-0 mb-1 font-bold text-[15px]">
                <WaText nodes={parseWhatsApp(header.text)} values={headerValues} markValues={markValues} />
              </p>
            ) : null}
            {body ? (
              <p className="m-0">
                <WaText nodes={parseWhatsApp(body)} values={bodyValues} markValues={markValues} />
                {footer ? null : TIME_SPACER}
              </p>
            ) : (
              <p className="m-0 text-(--wa-muted) italic">The body appears here.</p>
            )}
            {footer ? (
              <p className="m-0 mt-1 text-[13px] text-(--wa-muted)">
                {footer}
                {TIME_SPACER}
              </p>
            ) : null}
            <span className="absolute right-2 bottom-1 text-[11px] text-(--wa-muted)">{time}</span>
          </div>
          {shown.map((button, index) => {
            const Icon = BUTTON_ICONS[button.kind];
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: buttons are positional
                key={index}
                className="flex items-center justify-center gap-1.5 border-t border-(--wa-rule) px-2 py-2.5 text-[14px] text-(--wa-link)"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{button.text || "Button"}</span>
              </div>
            );
          })}
        </div>
      </div>
    </figure>
  );
}
