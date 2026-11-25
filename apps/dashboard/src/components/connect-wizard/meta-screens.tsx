import type { ConnectPath } from "../../lib/embedded-signup";
import { cn } from "@/lib/utils";

/** Thumbnails of Meta's screens: shapes, not screenshots, so they never claim Meta's exact pixels. */
type Sketch = "login" | "business" | "qr" | "history" | "details" | "code";

const BOX = "border border-(--line-strong)";
const INK = "border border-foreground";

function Thumb({ sketch }: { sketch: Sketch }) {
  switch (sketch) {
    case "login":
      return (
        <div className="flex flex-col items-center gap-1.5">
          <span className={cn("h-2.25 w-16", BOX)} />
          <span className={cn("h-2.25 w-16", BOX)} />
          <span className="h-2.25 w-16 bg-muted-foreground" />
        </div>
      );
    case "business":
      return (
        <div className="flex flex-col items-center gap-1.5">
          <span className={cn("flex h-3 w-18 items-center justify-between px-1", INK)}>
            <span className="h-0.5 w-8 bg-foreground" />
            <span className="size-1 bg-foreground" />
          </span>
          <span className="h-0.5 w-18 bg-(--line-strong)" />
          <span className="h-0.5 w-18 bg-(--line-strong)" />
        </div>
      );
    case "qr":
      return (
        <svg viewBox="0 0 44 44" className="size-11 fill-none stroke-foreground">
          <rect x="2" y="2" width="12" height="12" strokeWidth="3" />
          <rect x="30" y="2" width="12" height="12" strokeWidth="3" />
          <rect x="2" y="30" width="12" height="12" strokeWidth="3" />
          <path d="M21 2v8m0 6v6h-6m-13 0h8m18-2h8m-22 8v8m6-14v6h6v8h8m-8-8h8" strokeWidth="2.5" />
        </svg>
      );
    case "history":
      return (
        <div className="flex flex-col gap-2.5">
          <span className="flex w-17 items-center gap-1.5">
            <span className="size-2 bg-foreground" />
            <span className="h-0.5 w-12 bg-foreground" />
          </span>
          <span className="flex w-17 items-center gap-1.5">
            <span className={cn("size-2", BOX)} />
            <span className="h-0.5 w-9 bg-(--line-strong)" />
          </span>
        </div>
      );
    case "details":
      return (
        <div className="flex flex-col items-center gap-2">
          <span className="flex gap-1">
            <span className={cn("h-3 w-4.5", INK)} />
            <span className={cn("h-3 w-12.5", INK)} />
          </span>
          <span className={cn("h-3 w-18", BOX)} />
        </div>
      );
    case "code":
      return (
        <div className="flex gap-0.75">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={cn("h-3.5 w-2.5", i < 3 ? INK : BOX)} />
          ))}
        </div>
      );
  }
}

const LOGIN = {
  sketch: "login",
  title: "Log in with Facebook",
  body: 'Use your own account. If it asks "Continue as you?", say yes.',
} as const;
const BUSINESS = {
  sketch: "business",
  title: "Choose your business",
  body: 'Meta calls it a "business portfolio". Pick yours from the list. If the list is empty, create one with the name of your business.',
} as const;

const META_SCREENS: Record<ConnectPath, { sketch: Sketch; title: string; body: string }[]> = {
  "business-app": [
    LOGIN,
    BUSINESS,
    {
      sketch: "qr",
      title: "Scan a square code with your phone",
      body: "Meta sends a message to your WhatsApp Business app. Open it, tap the button, and point the phone at the code on your computer screen.",
    },
    {
      sketch: "history",
      title: "Decide about your old chats",
      body: "Say yes to see your recent chats in Eccos too. Say no to start from today. Both work, and your phone keeps everything either way.",
    },
  ],
  "new-number": [
    LOGIN,
    BUSINESS,
    {
      sketch: "details",
      title: "Type your number and your business name",
      body: "Write the number with its country code. The name is what your customers will see, so use the real name of your business.",
    },
    {
      sketch: "code",
      title: "Enter the code Meta sends you",
      body: "Choose SMS or a call. A six-digit code reaches the phone in a few seconds. Type it into Meta's window.",
    },
  ],
};

/** Meta's four screens for a path, in order, each with its thumbnail. */
export function MetaScreens({ path }: { path: ConnectPath }) {
  const screens = META_SCREENS[path];
  return (
    <ol className="m-0 list-none p-0">
      {screens.map((screen, i) => (
        <li
          key={screen.title}
          className={cn("flex items-start gap-4 border-t border-border", i === screens.length - 1 ? "pt-4" : "py-4")}
        >
          <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center border border-(--line-strong) text-xs leading-4 font-semibold text-foreground">
            {i + 1}
          </span>
          <span aria-hidden="true" className="hidden h-18 w-26 shrink-0 items-center justify-center border border-(--line-strong) bg-background sm:flex">
            <Thumb sketch={screen.sketch} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="m-0 text-[15px] leading-5 font-semibold text-foreground">{screen.title}</p>
            <p className="m-0 text-sm text-muted-foreground">{screen.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
