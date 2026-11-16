import type { ReactNode } from "react";
import { Frame, FramePanel } from "@/components/reui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { IDENTITY_TIER, MACHINE_CLASS, SectionHeading, SUPPORT_TIER } from "./plain-table";

const SECTION_GRID = "grid gap-4 lg:grid-cols-3 lg:gap-8";

/**
 * A settings-style section: title and description in the left third, the
 * bordered content in the right two thirds from `lg` up, stacked below it.
 */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`${SECTION_GRID} scroll-mt-16 border-t border-(--line) pt-6 first:border-t-0 first:pt-0`}
    >
      <div className="flex flex-col gap-1.5">
        <SectionHeading id={`${id}-title`} title={title} />
        {description ? <p className={`m-0 max-w-prose text-pretty ${SUPPORT_TIER}`}>{description}</p> : null}
      </div>
      <div className="min-w-0 lg:col-span-2">{children}</div>
    </section>
  );
}

/** The bordered surface a section's rows or controls sit on. `flush` drops the padding for edge-to-edge rows. */
export function SectionFrame({ flush, children }: { flush?: boolean; children: ReactNode }) {
  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit className={flush ? "p-0" : undefined}>
        {children}
      </FramePanel>
    </Frame>
  );
}

/** Label/value rows that close on the frame's own edge, with no band under the last one. */
export function Rows({ children }: { children: ReactNode }) {
  return <dl className="m-0 divide-y divide-(--line)">{children}</dl>;
}

/** One label/value row: label in the machine voice, value in the identity tier, its action at the right edge. */
export function Row({ label, children, action }: { label: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-4 px-5 py-3">
      <dt className={`w-32 shrink-0 ${MACHINE_CLASS}`}>{label}</dt>
      <dd className="m-0 flex min-w-0 flex-1 items-center gap-4">
        <span className={`min-w-0 break-words ${IDENTITY_TIER}`}>{children}</span>
        {action ? <span className="ml-auto shrink-0">{action}</span> : null}
      </dd>
    </div>
  );
}

/** A page of sections still loading: one skeleton per section, in the same grid. */
export function SectionsSkeleton({ heights }: { heights: string[] }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      {heights.map((height) => (
        <div key={height} className={SECTION_GRID}>
          <Skeleton className="h-12" />
          <Skeleton className={`lg:col-span-2 ${height}`} />
        </div>
      ))}
    </div>
  );
}
