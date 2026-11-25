import { cn } from "@/lib/utils";
import { shortTime } from "../../lib/setup-test";

export type ChatMessage = { key: string; direction: "in" | "out"; text: string; at: number; delivered?: boolean };

/** WhatsApp's double tick, as the phone draws it on a delivered message. */
function Ticks() {
  return (
    <svg aria-hidden="true" width="16" height="10" viewBox="0 0 16 10" className="shrink-0">
      <path
        d="M1 5.5 3.8 8.3 9.5 1.7M6.5 7.3l1 1L13.8 1.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.direction === "in") {
    return (
      <div className="flex max-w-[85%] items-end gap-2.5 self-start rounded-[8px] bg-(--wa-bubble) px-2.5 py-1.75">
        <span className="text-sm leading-4.75 break-words text-(--wa-ink)">{message.text}</span>
        <span className="shrink-0 text-[11px] leading-3.5 text-(--wa-muted)">{shortTime(message.at)}</span>
      </div>
    );
  }
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-0.5 self-end rounded-[8px] bg-(--wa-out) px-2.5 py-1.75">
      <span className="text-sm leading-4.75 break-words text-(--wa-ink)">{message.text}</span>
      <span className="flex items-center gap-1 text-[11px] leading-3.5 text-(--wa-out-muted)">
        {shortTime(message.at)}
        {message.delivered ? <Ticks /> : null}
      </span>
    </div>
  );
}

/**
 * The chat as the phone shows it. It depicts WhatsApp, so it wears WhatsApp's
 * bubble radii and `--wa-*` palette inside a square frame (DASHBOARD-DESIGN.md,
 * the WhatsApp preview exception).
 */
export function ChatPreview({
  title,
  to,
  messages,
  placeholder,
  className,
}: {
  title: string;
  /** The number it was sent to, muted after an arrow. */
  to?: string;
  messages: ChatMessage[];
  /** Said in an empty chat. */
  placeholder?: string;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled picture of a chat, not a form group
    <div
      role="group"
      aria-label="The chat, as WhatsApp shows it"
      className={cn("flex w-full flex-col border border-(--line-strong) bg-(--wa-wall)", className)}
    >
      <div className="flex h-9 shrink-0 items-center bg-(--wa-bar) px-3">
        <p className="m-0 truncate text-[13px] leading-4.5 text-(--wa-ink)">
          {title}
          {to ? <span className="text-(--wa-muted)"> → {to}</span> : null}
        </p>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-2 px-3 py-3.5">
        {messages.length === 0 && placeholder ? (
          <>
            <span aria-hidden="true" className="h-9.5 w-42 rounded-[8px] border border-dashed border-(--wa-muted) opacity-60" />
            <p className="m-0 text-[13px] leading-4.5 text-(--wa-muted)">{placeholder}</p>
          </>
        ) : (
          messages.map((message) => <Bubble key={message.key} message={message} />)
        )}
      </div>
    </div>
  );
}
