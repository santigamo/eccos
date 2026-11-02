/** Pulls the examples out of the public docs markdown, so contract tests never copy them. */

export interface Fence {
  lang: string;
  code: string;
}

export function fences(md: string): Fence[] {
  return [...md.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map((m) => ({
    lang: m[1] ?? "",
    code: m[2] ?? "",
  }));
}

export function jsonFences(md: string): Record<string, unknown>[] {
  return fences(md)
    .filter((f) => f.lang === "json")
    .map((f) => JSON.parse(f.code));
}

/** Rows of the first markdown table after `heading` (or the first table), header rows excluded. */
export function tableRows(md: string, heading?: string): string[][] {
  const start = heading ? md.indexOf(heading) : 0;
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const lines = md.slice(start).split("\n");
  const first = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    );
  }
  return rows.slice(2);
}

export function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** The JSON string literal in a cell's first code span, e.g. `"rate limited"` -> rate limited. */
export function quoted(cell: string): string {
  return JSON.parse(codeSpans(cell)[0] ?? "") as string;
}
