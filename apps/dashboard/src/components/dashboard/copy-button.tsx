import { useEffect, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

/** Copies `value`, says so for a moment, and says so when the browser refuses. */
export function CopyButton({
  value,
  label = "Copy",
  ...props
}: { value: string; label?: string } & Omit<ComponentProps<typeof Button>, "onClick" | "children" | "value">) {
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
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}
