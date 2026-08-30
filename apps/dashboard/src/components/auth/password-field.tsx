/**
 * Password input with visibility toggle (eccos-qde).
 *
 * Wraps the shared Input with a show/hide button inside the field container.
 * aria-pressed reflects the revealed state; aria-describedby additionally
 * points at the toggle so screen readers announce the control. The label
 * follows the machine-voice auth pattern (11px uppercase).
 */

import { useId, useState } from "react";
import { Input } from "../ui/input";

export interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  /** Set when the surrounding form is in an error state (aria-invalid). */
  hasError?: boolean;
  /** DOM id of the error paragraph for aria-describedby wiring. */
  errorId?: string;
  minLength?: number;
  required?: boolean;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hasError,
  errorId,
  minLength,
  required,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const toggleId = useId();
  const describedBy = [errorId, toggleId].filter(Boolean).join(" ");

  return (
    <label
      htmlFor={id}
      className="flex flex-col gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
    >
      {label}
      <span className="relative flex items-center">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
          aria-invalid={hasError ? true : undefined}
          aria-describedby={describedBy}
          className="pr-12"
        />
        <button
          type="button"
          id={toggleId}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="absolute right-1.5 rounded-none px-1.5 py-0.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"
        >
          {visible ? "Hide" : "Show"}
        </button>
      </span>
    </label>
  );
}
