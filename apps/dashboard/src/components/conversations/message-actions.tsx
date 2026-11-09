import { ReplyIcon, SmilePlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ThreadEntry } from "../../lib/conversations";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/**
 * Reply and React beside one message. On touch they are always there; on a desktop
 * they appear on hover or focus, and stay while the React menu is open.
 */
export function MessageActions({
  entry,
  onReply,
  onReact,
}: {
  entry: ThreadEntry;
  onReply?: (entry: ThreadEntry) => void;
  onReact?: (entry: ThreadEntry, emoji: string) => void;
}) {
  const [reacting, setReacting] = useState(false);
  return (
    <div className="flex shrink-0 gap-1 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
      {onReply ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Reply"
          onClick={() => onReply(entry)}
        >
          <ReplyIcon />
        </Button>
      ) : null}
      {onReact ? (
        <Popover open={reacting} onOpenChange={setReacting}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="React"
              />
            }
          >
            <SmilePlusIcon />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto flex-row gap-1 p-1">
            {QUICK_EMOJIS.map((emoji) => {
              // The reaction already on the message is picked again to remove it.
              const mine = entry.myReaction === emoji;
              return (
                <Button
                  key={emoji}
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`React with ${emoji}`}
                  aria-pressed={mine}
                  className="aria-pressed:border-(--ghost-edge-hover) aria-pressed:bg-(--ghost-fill-hover)"
                  onClick={() => {
                    setReacting(false);
                    onReact(entry, mine ? "" : emoji);
                  }}
                >
                  {emoji}
                </Button>
              );
            })}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
