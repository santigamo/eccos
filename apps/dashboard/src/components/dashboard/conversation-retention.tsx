import { useState, type FormEvent } from "react";
import { setConversationRetention, type Result } from "../../server/gateway";
import { failureCopy } from "../../lib/failure";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MACHINE_CLASS = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";
const ERROR_CLASS =
  "bg-destructive/10 text-destructive-foreground mt-3 block border border-destructive/20 p-3 text-xs";

const KEEP_FOREVER = "forever";

/** The choices the control offers. `forever` is the default, and the stored
 * value when a workspace has never set one. */
export const RETENTION_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: KEEP_FOREVER, label: "Keep forever" },
  { value: "30", label: "Delete after 30 days" },
  { value: "90", label: "Delete after 90 days" },
  { value: "365", label: "Delete after 365 days" },
];

function choiceOf(days: number | null): string {
  return days === null ? KEEP_FOREVER : String(days);
}

function labelOf(value: string): string {
  return RETENTION_CHOICES.find((item) => item.value === value)?.label ?? value;
}

/**
 * Conversation history retention for the workspace (eccos-yqbz.4).
 *
 * Router-free like the API keys panel: the route owns the value and re-reads
 * it through `onChanged`. The server requires `administer`, so a role without
 * it gets the refusal copy here instead of the control.
 */
export function ConversationRetentionPanel({
  retention,
  onChanged,
}: {
  retention: Result<number | null>;
  onChanged?: () => void;
}) {
  const saved = retention.ok ? choiceOf(retention.data) : KEEP_FOREVER;
  const [choice, setChoice] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const days = choice === KEEP_FOREVER ? null : Number(choice);
      const res = await setConversationRetention({ data: { days } });
      if (!res.ok) {
        setError(failureCopy(res).detail);
        return;
      }
      onChanged?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Frame variant="default" spacing="lg">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-sm font-semibold">Conversation history</FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            How long Eccos keeps conversations and contacts. The short buffer used for
            forwarding is separate and is not affected.
          </FrameDescription>
        </FrameHeader>

        {retention.ok ? (
          <form onSubmit={onSave} aria-busy={saving} className="mt-5 flex flex-col gap-3">
            <div>
              <label htmlFor="conversation-retention" className={`mb-1 block ${MACHINE_CLASS}`}>
                Keep conversations
              </label>
              <Select value={choice} onValueChange={(value) => setChoice(value ?? KEEP_FOREVER)}>
                <SelectTrigger id="conversation-retention" size="sm" className="w-full rounded-none">
                  <SelectValue>{labelOf(choice)}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  {RETENTION_CHOICES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {choice !== KEEP_FOREVER ? (
                <p className="mt-1.5 mb-0 text-xs text-muted-foreground">
                  Older conversations and contacts are deleted for every number in this
                  workspace.
                </p>
              ) : null}
            </div>
            <div>
              <Button
                type="submit"
                variant="outline"
                disabled={saving || choice === saved}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
            {error ? (
              <output aria-live="polite" className={ERROR_CLASS}>
                {error}
              </output>
            ) : null}
          </form>
        ) : (
          <div className="mt-5">
            <span className={`block ${MACHINE_CLASS}`}>{failureCopy(retention).title}</span>
            <p className="mt-1.5 mb-0 text-sm text-muted-foreground">
              {failureCopy(retention).detail}
            </p>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}
