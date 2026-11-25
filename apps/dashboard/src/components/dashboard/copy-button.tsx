import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

/** Copies `value`, says so for a moment, and says so when the browser refuses. */
export function CopyButton({
  value,
  label,
  labels = { copy: "Copy", copied: "Copied", failed: "Copy failed" },
  icon,
  ...props
}: {
  value: string;
  label?: string;
  /** For a page that is not in English. */
  labels?: { copy: string; copied: string; failed: string };
  icon?: ReactNode;
} & Omit<ComponentProps<typeof Button>, "onClick" | "children" | "value">) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <Button type="button" {...props} onClick={() => void copy()}>
      {icon}
      {state === "copied" ? labels.copied : state === "failed" ? labels.failed : (label ?? labels.copy)}
    </Button>
  );
}
