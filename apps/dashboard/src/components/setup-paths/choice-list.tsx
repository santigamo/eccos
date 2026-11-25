import { ArrowRightIcon, type LucideIcon } from "lucide-react";
import { CHOICE_CARD } from "../connect-wizard/path-step";

export type Choice<T extends string> = { id: T; icon: LucideIcon; title: string; detail: string };

/** The wizard's choice cards: one button each, icon, title, detail and an arrow. */
export function ChoiceList<T extends string>({ choices, onPick }: { choices: Choice<T>[]; onPick: (id: T) => void }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {choices.map(({ id, icon: Icon, title, detail }) => (
        <li key={id}>
          <button type="button" onClick={() => onPick(id)} className={CHOICE_CARD}>
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center border border-(--line-strong) text-ink transition-colors group-hover:border-(--ghost-edge-hover)"
            >
              <Icon className="size-4.5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[15px] leading-5 font-semibold text-foreground">{title}</span>
              <span className="text-sm text-pretty text-muted-foreground">{detail}</span>
            </span>
            <span aria-hidden="true" className="flex h-10 w-5 shrink-0 items-center justify-center text-foreground">
              <ArrowRightIcon className="size-4.5" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
