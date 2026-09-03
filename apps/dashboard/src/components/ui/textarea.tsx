import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The console's multi-line text field.
 *
 * Vendored from shadcn and put through the square pass: `rounded-none`, the
 * `--line-strong` interactive edge (`border-input` carries that value), the
 * ghost body (`dark:bg-input/30`) and the green focus ring. Its class chain is
 * deliberately `input.tsx`'s, field for field — the two sit in the same form,
 * and a textarea styled on its own terms would make one form contradict itself
 * between its single-line and multi-line inputs. What differs is only what
 * multi-line requires: no fixed height, `field-sizing-content` so it grows with
 * the body being typed, and a floor so an empty one still reads as a text area.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content min-h-20 w-full min-w-0 rounded-none border border-input bg-transparent px-2.5 py-1.5 text-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 md:text-xs dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
