import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { SPLIT_GRID, SPLIT_MAIN, StatusTag } from "../../ui";
import { MACHINE_CLASS } from "../dashboard/plain-table";
import { ApiDoor, FullRequest } from "./api-door";

type DoorProps = Omit<ComponentProps<typeof ApiDoor>, "open" | "onToggle" | "panelId">;

/**
 * What a list page says before it holds anything: what the thing is, the API door,
 * and an example in its own frames, never a sample row in the live grid. A
 * filtered or tabbed view that is empty keeps `GridEmptyState`.
 */
export function FirstRun({
  label,
  title,
  lede,
  door,
  fullRequestLabel,
  example,
  footnote,
}: {
  label: string;
  title: string;
  lede: string;
  door: DoorProps;
  fullRequestLabel: string;
  example: ReactNode;
  footnote: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="flex flex-col gap-9">
      <div className={SPLIT_GRID}>
        <div className={`flex flex-col gap-2.5 ${SPLIT_MAIN}`}>
          <p className={`m-0 ${MACHINE_CLASS}`}>{label}</p>
          <h2 className="m-0 text-2xl font-semibold tracking-[-0.015em] text-foreground">{title}</h2>
          <p className="m-0 max-w-prose text-[15px] leading-6 text-pretty text-muted-foreground">{lede}</p>
        </div>
        <ApiDoor {...door} open={open} onToggle={() => setOpen((was) => !was)} panelId={panelId} />
      </div>
      {open ? <FullRequest id={panelId} label={fullRequestLabel} curl={door.curl} /> : null}
      <section aria-label="Example" className="flex flex-col gap-2">
        <p className={`m-0 ${MACHINE_CLASS}`}>Example</p>
        <div className="grid gap-8 xl:grid-cols-3">{example}</div>
        <p className="m-0 pt-1 text-sm text-muted-foreground">{footnote}</p>
      </section>
    </div>
  );
}

/** One numbered frame of a first-run example. */
export function ExampleStep({
  step,
  title,
  tag,
  note,
  children,
}: {
  step: number;
  title: string;
  tag?: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 border border-(--line) bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className={`m-0 flex items-center gap-2 ${MACHINE_CLASS}`}>
          <span className="font-pixel text-sm text-foreground">{step}</span>
          {title}
        </p>
        {tag ? <StatusTag status={tag} /> : null}
      </div>
      <div className="flex grow flex-col">{children}</div>
      <p className="m-0 text-sm text-muted-foreground">{note}</p>
    </div>
  );
}
