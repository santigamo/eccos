import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LiveRefresh } from "../../hooks/use-live-refresh";

/** Refresh and the live toggle, for a log page's header actions. */
export function RefreshControls({ live, setLive, refreshing, refresh }: LiveRefresh) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={refresh}
        aria-busy={refreshing}
      >
        <RefreshCw
          aria-hidden="true"
          className={cn(refreshing && "motion-safe:animate-spin motion-reduce:opacity-40")}
        />
        Refresh
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={live}
        onClick={() => setLive(!live)}
        title={live ? "Updating every 5 seconds" : "Update every 5 seconds"}
        // Stacked on `hover:` too, or the outline variant's hover would repaint
        // the on state as off under the pointer.
        className="aria-pressed:border-(--tag-live-edge) aria-pressed:bg-(--tag-live-bg) aria-pressed:text-(color:--tag-live-ink) aria-pressed:hover:border-(--tag-live-edge) aria-pressed:hover:bg-(--tag-live-bg) aria-pressed:hover:text-(color:--tag-live-ink)"
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 border border-current", live ? "bg-current" : "opacity-60")}
        />
        {live ? "Live on" : "Live off"}
      </Button>
    </>
  );
}
