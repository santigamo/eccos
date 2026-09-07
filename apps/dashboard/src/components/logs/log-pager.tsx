import { Button } from "@/components/ui/button";

/**
 * The cursor pager every log carries.
 *
 * `before` is an EXCLUSIVE row id, not an offset: rows arrive constantly, and
 * an offset page-2 would silently re-show rows that page 1 had already pushed
 * down. The id is stable — page 2 of a log is the same fifty rows whenever it
 * is loaded.
 *
 * Shared because two of the three logs had no pagination at all and simply
 * showed the newest fifty, with row fifty-one unreachable by any means. A log
 * whose oldest visible row is an accident of volume is not a log.
 *
 * "Load older" disables rather than hides when there is nothing more: the
 * control's presence is what tells an operator the page is complete, and a
 * control that vanishes reads as a layout shift.
 */
export function LogPager({
  canLoadOlder,
  hasCursor,
  onLatest,
  onOlder,
}: {
  canLoadOlder: boolean;
  /** Whether the view is already past the newest page. */
  hasCursor: boolean;
  onLatest: () => void;
  onOlder: () => void;
}) {
  return (
    <div className="mt-3 flex justify-end gap-2">
      {hasCursor ? (
        <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={onLatest}>
          ← Latest
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-none"
        disabled={!canLoadOlder}
        onClick={onOlder}
      >
        Load older →
      </Button>
    </div>
  );
}
