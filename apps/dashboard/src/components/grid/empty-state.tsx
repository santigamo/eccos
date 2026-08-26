import type { ReactNode } from "react"

/**
 * The structured empty state every log grid renders in place of its rows.
 *
 * Passed to `LogGrid`'s `emptyMessage`, which the data grid renders inside a
 * full-width `<td colSpan>` — so the header row stays put and this block is
 * centered in the empty table area.
 *
 * Three registers, in order:
 *  1. `label` — machine voice (pixel, uppercase micro-label).
 *  2. `description` — one plain sentence, at prose size, saying what will
 *     eventually appear here.
 *  3. `action` — optional, and only where an action actually exists.
 */
export function GridEmptyState({
  label,
  description,
  action,
}: {
  label: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-xs flex-col items-center gap-2 py-4 text-center">
      <p className="text-[11px] font-medium tracking-wider uppercase text-muted-foreground">
        {label}
      </p>
      <p className="text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
