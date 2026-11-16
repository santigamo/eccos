import type { MemberRole } from "../../members";
import { ROLE_OPTIONS } from "../../lib/member-roles";

/** The three grantable roles as radio cards, each with the one line that says what it can do. */
export function RoleChoices({
  name,
  value,
  onChange,
}: {
  name: string;
  value: MemberRole | null;
  onChange: (role: MemberRole) => void;
}) {
  return (
    <>
      {ROLE_OPTIONS.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer flex-col gap-0.5 border border-(--line-strong) bg-(--ghost-fill) px-3 py-2.5 transition-colors hover:border-(--ghost-edge-hover) hover:bg-(--ghost-fill-hover) has-checked:border-(--ghost-edge-hover) has-checked:bg-(--tint-live) has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          <span className="text-sm font-medium text-foreground">{option.label}</span>
          <span className="text-xs text-muted-foreground">{option.description}</span>
        </label>
      ))}
    </>
  );
}
