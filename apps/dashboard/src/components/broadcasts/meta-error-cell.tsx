import { EMPTY_CELL, errorReading } from "../../lib/logs";

/** Meta's stored error envelope as one clamped cell: the code in mono, then its text. */
export function MetaErrorCell({ raw }: { raw: string | null }) {
  if (!raw) return EMPTY_CELL;
  const { code, text, label } = errorReading(raw);
  return (
    <span className="line-clamp-2 max-w-sm [overflow-wrap:anywhere]" title={label}>
      {code ? <span className="font-mono text-xs">{code} · </span> : null}
      {text}
    </span>
  );
}
