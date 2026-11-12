import { encode } from "uqr";

/**
 * Black on white in both themes: a phone camera needs the contrast, so this
 * depicts the code rather than wearing the console's palette.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { border: 2 });
  const path = data
    .flatMap((column, x) => column.map((on, y) => (on ? `M${x} ${y}h1v1h-1z` : "")))
    .join("");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-44 shrink-0 bg-white text-black"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
