import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "../dashboard/copy-button";
import { MACHINE_CLASS } from "../dashboard/plain-table";

export type DoorRequest = { method: "POST" | "PUT" | "DELETE"; path: string; note?: string };

const FOOT_LINK = "text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground";

/**
 * The API door of a first-run block: the request in one line per call, the full
 * request behind a disclosure the block lays out below, and "Copy as curl".
 */
export function ApiDoor({
  sentence,
  requests,
  curl,
  open,
  onToggle,
  panelId,
  guide,
  canCreateKey,
}: {
  sentence: string;
  requests: DoorRequest[];
  curl: string;
  open: boolean;
  onToggle: () => void;
  panelId: string;
  guide: { href: string; label: string };
  canCreateKey: boolean;
}) {
  return (
    <aside aria-label="From your own system" className="flex flex-col border border-(--line) bg-card lg:sticky lg:top-4">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <p className={`m-0 ${MACHINE_CLASS}`}>From your own system</p>
          <p className="m-0 text-sm font-medium text-foreground">{sentence}</p>
        </div>
        <ul className="m-0 list-none divide-y divide-(--line) border border-(--line) bg-background p-0">
          {requests.map((request) => (
            <li key={`${request.method} ${request.path} ${request.note}`} className="flex items-center gap-2.5 px-3 py-2 font-mono text-xs">
              <span
                className={cn(
                  "shrink-0 font-semibold",
                  request.method === "DELETE" ? "text-destructive-foreground" : "text-ink",
                )}
              >
                {request.method}
              </span>
              <span className="min-w-0 truncate text-foreground">{request.path}</span>
              {request.note ? (
                <span className="ml-auto shrink-0 font-sans text-muted-foreground">{request.note}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
            className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-foreground underline underline-offset-4"
          >
            <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            {open ? "Hide the full request" : "Show the full request"}
          </button>
          <CopyButton value={curl} label="Copy as curl" variant="outline" size="sm" />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--line) px-4 py-2.5">
        {canCreateKey ? (
          <Link to="/api-keys" className={FOOT_LINK}>
            Create an API key
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">Ask an admin of this workspace for an API key.</span>
        )}
        <a href={guide.href} target="_blank" rel="noreferrer" className={FOOT_LINK}>
          {guide.label} ↗
        </a>
      </div>
    </aside>
  );
}

/** The whole request, across the block's full width once the door opens it. */
export function FullRequest({ id, label, curl }: { id: string; label: string; curl: string }) {
  return (
    <section id={id} aria-label="The full request" className="border border-(--line) bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-(--line) px-4 py-2">
        <p className={`m-0 ${MACHINE_CLASS}`}>{label}</p>
        <CopyButton value={curl} variant="link" size="sm" className="h-auto p-0 text-xs underline underline-offset-4" />
      </div>
      <pre className="m-0 overflow-x-auto p-4 font-mono text-xs leading-5 text-foreground">{curl}</pre>
    </section>
  );
}
