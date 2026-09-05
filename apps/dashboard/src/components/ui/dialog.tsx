"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

/**
 * The console's centred dialog, vendored from shadcn's `base-lyra` style and
 * put through the square pass (`rounded-none`, the `--line` hairline, the solid
 * `--popover` surface — the glass rule: floating things sit over text).
 *
 * ── WHY A THIRD OVERLAY FILE, AND WHY IT IS NOT A THIRD PRIMITIVE ───────────
 * This wraps `@base-ui/react/dialog`, which is the SAME primitive `sheet.tsx`
 * wraps: a sheet is a dialog docked to a side. What differs is the register,
 * and the register is the whole point (see the overlay rule in
 * docs/DASHBOARD-DESIGN.md):
 *
 *   - `alert-dialog.tsx` confirms a ONE-CLICK destructive act asked for
 *     elsewhere — a Delete on a row, then this.
 *   - THIS FILE carries a DECISION the operator must read before leaving the
 *     page: no fields, no submit, the choices themselves are the actions.
 *   - `sheet.tsx` carries a task done beside the list, or a read-only look at
 *     one row.
 *
 * ── DISMISSAL IS THE CALLER'S RESPONSIBILITY ────────────────────────────────
 * Unlike `AlertDialog` — whose mode forces `disablePointerDismissal` — a plain
 * dialog dismisses on Escape AND on any outside press. That is right for a
 * decision nobody has committed to yet, and WRONG the moment something
 * irreversible is in flight: dismissing then unmounts the component that owns
 * the in-flight callbacks, so a failure lands nowhere. The rule's corollary is
 * that such a caller refuses backdrop and Escape while the operation runs
 * (`disablePointerDismissal`, plus refusing the Escape reason in
 * `onOpenChange`) and keeps an explicit close. `/numbers` does exactly that
 * while Meta's popup is open.
 */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

/** The same backdrop as the other two overlays, to the class. A dialog that
 * dimmed the page differently from the confirm beside it would read as a
 * different system, not a different register. */
function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // `sm:max-w-lg`, not the vendored `sm:max-w-sm`: this register exists
          // to be READ, and the console's decision copy — the consequence line
          // on a connect path, say — wraps to two lines at the sheet's width.
          // Narrow it per call site when the content is short; do not narrow
          // the default and make every caller remember.
          //
          // `top-1/2`, matching `alert-dialog.tsx`. The first-run frame on
          // /numbers lifts itself off centre (`pb-[10vh]`) because it is a full
          // page of mostly empty column; a small popup over a populated page is
          // not that, and a second vertical anchor in the same visual family
          // would only read as drift.
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-none border border-(--line) bg-popover bg-clip-padding p-4 text-xs/relaxed text-popover-foreground shadow-lg transition duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button variant="ghost" className="absolute top-3 right-3" size="icon-sm" />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-row items-center justify-end gap-2", className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-sm font-medium text-foreground", className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("m-0 text-xs/relaxed text-pretty text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
