"use client"

import { useEffect, useState } from "react"
import { Link, useLoaderData, useSearch } from "@tanstack/react-router"

import { cn } from "@/lib/utils"
import {
  setupComplete,
  setupDone,
  setupSteps,
  type SetupStep,
} from "@/lib/setup-checklist"

/**
 * The first-run checklist, in the sidebar above the user tile.
 *
 * Four facts, derived on every load (`lib/setup-checklist.ts`), each a link to
 * the page that produces the fact. No wizard, no stored progress, no route of
 * its own — see that module for the argument.
 *
 * ── WHERE "HIDE" PERSISTS, AND WHY THERE ────────────────────────────────────
 * `localStorage`, per viewer and per browser. The alternative considered was
 * the Better Auth organization's `metadata` JSON, which would make the choice
 * follow the workspace instead of the browser — but the console does not write
 * organization metadata ANYWHERE today (the column exists in
 * `migrations/0001_better_auth_schema.sql` and nothing has ever set it), so
 * taking it on for this would mean introducing an org-mutation path, its
 * permission story and its audit line for a preference about a sidebar block.
 * Per viewer is also arguably the truer scope: dismissing it is "I have read
 * this", which is a fact about a person, not about a workspace.
 *
 * The read happens in an effect rather than during render because the console
 * server-renders: touching `localStorage` in the render pass would either crash
 * on the server or hydrate to different markup. A viewer who dismissed the
 * block therefore sees it for one paint. That is the cost of a dismissal that
 * costs no round trip, and it is paid only by people who dismissed it.
 */
const DISMISSED_KEY = "eccos:setup-checklist-dismissed"

export function NavSetup() {
  const root = useLoaderData({ from: "__root__" })
  const { wabaId } = useSearch({ from: "__root__" })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === "1") setDismissed(true)
    } catch {
      // Private modes and blocked storage throw on access. A checklist is not
      // worth a broken sidebar, so the failure mode is "it stays visible".
    }
  }, [])

  if (!root.ok) return null
  const steps = setupSteps(root.data, root.hasForwardingTarget)
  if (dismissed || setupComplete(steps)) return null

  function hide() {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1")
    } catch {
      // Same as above: the session-local hide still worked.
    }
  }

  return (
    <nav
      aria-label="Setup"
      // Hidden with the group labels in the collapsed rail: a 48px column has
      // no room for a list of words, and an icon-only checklist would be four
      // unreadable marks.
      className="in-data-[state=collapsed]:hidden border-t border-(--line) px-2 pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          Setup{" · "}
          <span className="tabular-nums">
            {setupDone(steps)}/{steps.length}
          </span>
        </p>
        <button
          type="button"
          onClick={hide}
          className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Hide
        </button>
      </div>
      <ul className="m-0 mt-2 flex list-none flex-col p-0">
        {steps.map((step) => (
          <li key={step.id}>
            <Link
              to={step.href}
              search={{ wabaId }}
              className={cn(
                "flex items-center gap-2 py-1 text-xs transition-colors hover:text-foreground",
                step.state === "done" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              <StepMark state={step.state} />
              <span>{step.label}</span>
              <span className="sr-only">{STEP_STATE_WORDS[step.state]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

const STEP_STATE_WORDS: Record<SetupStep["state"], string> = {
  done: "(done)",
  "in-progress": "(in progress)",
  todo: "(not done yet)",
}

/**
 * A square, because nothing here rounds a corner. Filled green = done, amber
 * edge = waiting on Meta, plain interactive edge = not started. Colour is spent
 * only on the two states that mean something (data rule 1); the label ink
 * carries the rest.
 */
function StepMark({ state }: { state: SetupStep["state"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 shrink-0 border",
        state === "done"
          ? "border-primary bg-primary"
          : state === "in-progress"
            ? "border-[#f0a020]"
            : "border-(--line-strong)",
      )}
    />
  )
}
