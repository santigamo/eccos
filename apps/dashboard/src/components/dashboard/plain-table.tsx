import type { ReactNode } from "react";

/** The rail-separated table anatomy of /numbers, shared by the /members tables. */
export const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
export const ROW = "border-b border-(--line) transition-colors hover:bg-(--row-hover)";
export const CELL = "px-3 py-2.5";

export function Th({ children, srOnly }: { children: ReactNode; srOnly?: boolean }) {
  return <th className={`px-3 py-2 text-left ${srOnly ? "sr-only" : MACHINE_CLASS}`}>{children}</th>;
}
