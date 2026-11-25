"use client"

import { targetMissing } from "@/lib/forwarding"
import { useEffect, useState } from "react"
import { Link, useLoaderData, useSearch } from "@tanstack/react-router"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { timeLeft } from "@/lib/setup-window"
import {
  companionBilling,
  companionVisible,
  currentStep,
  setupDone,
  setupSteps,
  type CompanionBilling,
  type SetupStep,
} from "@/lib/setup-checklist"

/**
 * The setup companion, in the sidebar above the user tile: the observable
 * funnel stages (`lib/setup-checklist.ts`), each a link to the page that
 * produces its fact, as one vertical rail of done, current and next.
 *
 * `billing` (activated with hours left, paused, paid) comes from the account's
 * status and funnel clock (`companionBilling`); a test may pass it instead.
 *
 * "Hide" persists in `localStorage`, per viewer: dismissing it is "I have read
 * this", a fact about a person rather than a workspace, and the console writes
 * no organization metadata anywhere. The read happens in an effect because the
 * console server-renders, so a viewer who dismissed it sees it for one paint.
 */
const DISMISSED_KEY = "eccos:setup-checklist-dismissed"

export function NavSetup({ billing: given }: { billing?: CompanionBilling }) {
  const root = useLoaderData({ from: "__root__" })
  const { wabaId } = useSearch({ from: "__root__" })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === "1") setDismissed(true)
    } catch {
      // Blocked storage throws on access; the companion then stays visible.
    }
  }, [])

  if (!root.ok) return null
  const steps = setupSteps(root.data, !targetMissing(root.hasForwardingTarget))
  const billing = given ?? companionBilling(root.data, Date.now())
  if (dismissed || !companionVisible(steps, billing)) return null
  const current = currentStep(steps)

  function hide() {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1")
    } catch {
      // The session-local hide still worked.
    }
  }

  return (
    <nav
      aria-label="Setup"
      // Hidden in the collapsed rail: a 48px column has no room for words.
      className="in-data-[state=collapsed]:hidden mt-auto flex shrink-0 flex-col gap-3 border-t border-(--line) px-2 py-3"
    >
      <div className="flex items-center justify-between gap-2 text-[11px] leading-[14px] font-medium tracking-wider uppercase">
        <p className="m-0 text-muted-foreground">
          Setup ·{" "}
          <span className="text-foreground tabular-nums">
            {setupDone(steps)} of {steps.length}
          </span>
        </p>
        <button
          type="button"
          onClick={hide}
          className="cursor-pointer text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Hide
        </button>
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map((step, index) => {
          const isCurrent = step === current
          const isLast = index === steps.length - 1
          const label = (
            <>
              {step.label}
              <span className="sr-only"> {STEP_STATE_WORDS[step.state]}</span>
            </>
          )
          const labelClass = cn(
            "text-[13px] leading-[18px]",
            isCurrent ? "font-semibold text-foreground" : "text-muted-foreground",
          )
          return (
            <li
              key={step.id}
              aria-current={isCurrent ? "step" : undefined}
              className="flex gap-2.5"
            >
              <span aria-hidden="true" className="flex w-4 shrink-0 flex-col items-center gap-[3px] pt-px pb-[3px]">
                <StepMark state={step.state} isCurrent={isCurrent} index={index} />
                {!isLast && <span className="w-px grow bg-foreground/20" />}
              </span>
              <span className={cn("min-w-0 flex-1", !isLast && "pb-2.5")}>
                {step.href === null ? (
                  // A done step whose action is not repeatable: text, never a
                  // link (see the href contract in `lib/setup-checklist.ts`).
                  <span className={labelClass}>{label}</span>
                ) : (
                  <Link
                    to={step.href}
                    search={{ wabaId }}
                    className={cn(labelClass, "transition-colors hover:text-foreground hover:underline underline-offset-4")}
                  >
                    {label}
                  </Link>
                )}
              </span>
            </li>
          )
        })}
      </ol>
      {billing && billing.stage !== "paid" ? (
        <Link
          to="/billing"
          search={{ wabaId }}
          className="text-[13px] leading-[18px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {billing.stage === "activated"
            ? `Activated · ${timeLeft(billing.left)} to subscribe`
            : "Paused · subscribe to send again"}
        </Link>
      ) : null}
    </nav>
  )
}

const STEP_STATE_WORDS: Record<SetupStep["state"], string> = {
  done: "(done)",
  "in-progress": "(in progress)",
  todo: "(not done yet)",
}

/**
 * Square, like everything here. Done is a filled ink square with a check
 * (white, not green: green is for buttons), current is an ink frame with a
 * dot, next is a quiet frame with its number.
 */
function StepMark({ state, isCurrent, index }: { state: SetupStep["state"]; isCurrent: boolean; index: number }) {
  const base = "flex size-4 shrink-0 items-center justify-center border"
  if (state === "done") {
    return (
      <span className={cn(base, "border-foreground bg-foreground text-background")}>
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    )
  }
  if (isCurrent) {
    return (
      <span className={cn(base, "border-foreground")}>
        <span className="size-1 bg-foreground" />
      </span>
    )
  }
  return (
    <span className={cn(base, "border-(--line-strong) text-[10px] leading-3 font-semibold text-muted-foreground")}>
      {index + 1}
    </span>
  )
}
