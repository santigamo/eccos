import type { ReactNode } from "react";

/** Four strokes fading round a centre: the live test's "still listening". */
function WaitMark() {
  return (
    <span aria-hidden="true" className="flex h-5 w-6 shrink-0 items-center justify-center text-foreground">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square">
        <path d="M12 3v4" />
        <path d="M21 12h-4" opacity="0.7" />
        <path d="M12 21v-4" opacity="0.45" />
        <path d="M3 12h4" opacity="0.25" />
      </svg>
    </span>
  );
}

/** A live test's waiting line, announced when it changes. */
export function Waiting({ children }: { children: ReactNode }) {
  return (
    <output className="flex items-center gap-2">
      <WaitMark />
      <span className="text-sm text-muted-foreground">{children}</span>
    </output>
  );
}
