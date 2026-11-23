import type { ReactNode } from "react";

/** The console's plain rail-separated table (/numbers, /members) and the classes every panel shares. */
/** The functional register: Inter 11px uppercase (docs/DASHBOARD-DESIGN.md, "Two voices"). */
export const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
/** A refused panel action, under the control that caused it. */
export const ERROR_CLASS =
  "bg-destructive/10 text-destructive-foreground mt-3 block border border-destructive/20 p-3 text-xs";
export const ROW = "border-b border-(--line) transition-colors hover:bg-(--row-hover)";
export const CELL = "px-3 py-2.5";
/** For rows whose identity cell carries a second line. */
export const TALL_CELL = "px-3 py-3";

/**
 * Type tiers, one job each: 600 titles a section, 500 names what a row is
 * about, 400 supports it. Column headers and field labels stay MACHINE_CLASS.
 */
export const TITLE_TIER = "text-base font-semibold text-foreground";
export const IDENTITY_TIER = "text-sm font-medium text-foreground";
/** A second line under the identity. */
export const SECONDARY_TIER = "text-xs text-muted-foreground";
/** Any other cell, and descriptions. */
export const SUPPORT_TIER = "text-sm text-muted-foreground";

export function Th({ children, srOnly, width }: { children: ReactNode; srOnly?: boolean; width?: string }) {
  return (
    <th className={`px-3 py-2 text-left ${srOnly ? "sr-only" : MACHINE_CLASS}`} style={width ? { width } : undefined}>
      {children}
    </th>
  );
}

/** A section's title, with its count beside it. */
export function SectionHeading({ id, title, count }: { id?: string; title: string; count?: number }) {
  return (
    <h2 id={id} className={`m-0 ${TITLE_TIER}`}>
      {title}
      {count === undefined ? null : <span className="ml-2 font-normal text-muted-foreground">{count}</span>}
    </h2>
  );
}
