import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { pagerState, type PageCursor, type PageTarget, type PageTrail } from "@/lib/page-trail";

const CONTROL = { variant: "outline", size: "sm", className: "rounded-none" } as const;

function PageLink({ param, target, children }: { param: string; target: PageTarget; children: ReactNode }) {
  return (
    <Button
      {...CONTROL}
      nativeButton={false}
      render={
        <Link
          to="."
          search={(prev: Record<string, unknown>) => ({ ...prev, [param]: target.cursor, trail: target.trail })}
        />
      }
    >
      {children}
    </Button>
  );
}

/**
 * The cursor pager every log carries.
 *
 * The cursor is an EXCLUSIVE position, not an offset: rows arrive constantly,
 * and an offset page 2 would silently re-show rows page 1 had already pushed
 * down. Cursors only walk older, so Previous comes from the trail in the URL.
 *
 * Previous and Next disable rather than hide: the control's presence is what
 * tells an operator the page is complete, and one that vanishes reads as a
 * layout shift.
 */
export function LogPager({
  param = "before",
  cursor,
  trail,
  nextCursor,
  firstLabel = "Latest",
}: {
  /** The search param that carries this log's cursor. */
  param?: string;
  cursor: PageCursor | undefined;
  trail: PageTrail | undefined;
  nextCursor: PageCursor | null;
  /** For a log read oldest-first, where "Latest" would mislead. */
  firstLabel?: string;
}) {
  const { page, previous, next } = pagerState(cursor, trail, nextCursor);
  const showFirst = cursor !== undefined && (page === undefined || page > 2);

  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center justify-end gap-2">
      {showFirst ? (
        <PageLink param={param} target={{ cursor: undefined, trail: undefined }}>
          {firstLabel}
        </PageLink>
      ) : null}
      {previous ? (
        <PageLink param={param} target={previous}>
          ← Previous
        </PageLink>
      ) : (
        <Button {...CONTROL} disabled>
          ← Previous
        </Button>
      )}
      {page !== undefined ? (
        <span className="px-1 text-xs text-muted-foreground tabular-nums">Page {page}</span>
      ) : null}
      {next ? (
        <PageLink param={param} target={next}>
          Next →
        </PageLink>
      ) : (
        <Button {...CONTROL} disabled>
          Next →
        </Button>
      )}
    </nav>
  );
}
