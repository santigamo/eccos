import type { FailureCopy } from "../../lib/failure";
import { MACHINE_CLASS } from "./plain-table";

/** A page or section this role cannot use, in the anatomy of the pending note on /numbers. */
export function RoleNote({ copy }: { copy: FailureCopy }) {
  return (
    <div className="flex max-w-prose flex-col gap-1.5 border-t border-(--line) pt-3">
      <p className={`m-0 ${MACHINE_CLASS}`}>{copy.title}</p>
      <p className="m-0 text-sm text-pretty text-muted-foreground">{copy.detail}</p>
    </div>
  );
}
