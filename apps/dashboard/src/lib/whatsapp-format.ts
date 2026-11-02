/**
 * WhatsApp's message markup, read the way the app renders it: `*bold*`,
 * `_italic_`, `~strike~`, ```` ```mono``` ```` and `` `code` ``, with `{{1}}` /
 * `{{name}}` placeholders kept as their own nodes so a preview can fill or
 * highlight them.
 *
 * A marker only opens after a line start, whitespace or punctuation and only
 * closes before one, with no space just inside it — so `order_update_v2` and
 * `2*3*4` stay plain text, as they do on a phone. Markers never span lines,
 * except the triple-backtick block.
 */

export type WaNode =
  | { kind: "text"; text: string }
  | { kind: "var"; key: string }
  | { kind: "bold" | "italic" | "strike" | "mono"; children: WaNode[] };

const MARKERS: Record<string, "bold" | "italic" | "strike"> = {
  "*": "bold",
  _: "italic",
  "~": "strike",
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s\p{P}\p{S}]/u.test(char);
}

function textNodes(text: string): WaNode[] {
  const nodes: WaNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match.index > last) nodes.push({ kind: "text", text: text.slice(last, match.index) });
    nodes.push({ kind: "var", key: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push({ kind: "text", text: text.slice(last) });
  return nodes;
}

/** Where the marker opened at `start` closes on the same line, or -1. */
function closingIndex(text: string, start: number, marker: string): number {
  for (let j = start + 2; j < text.length; j++) {
    const char = text[j];
    if (char === "\n") return -1;
    if (char === marker && !/\s/.test(text[j - 1] ?? "") && isBoundary(text[j + 1])) return j;
  }
  return -1;
}

function parseInline(text: string): WaNode[] {
  const nodes: WaNode[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) nodes.push(...textNodes(plain));
    plain = "";
  };
  while (i < text.length) {
    const char = text[i] ?? "";
    if (char === "`" && !text.startsWith("```", i)) {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        flush();
        nodes.push({ kind: "mono", children: [{ kind: "text", text: text.slice(i + 1, end) }] });
        i = end + 1;
        continue;
      }
    }
    const kind = MARKERS[char];
    if (kind && isBoundary(text[i - 1]) && text[i + 1] && !/\s/.test(text[i + 1] ?? "")) {
      const end = closingIndex(text, i, char);
      if (end !== -1) {
        flush();
        nodes.push({ kind, children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    plain += char;
    i++;
  }
  flush();
  return nodes;
}

export function parseWhatsApp(text: string): WaNode[] {
  const nodes: WaNode[] = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf("```");
    const close = open === -1 ? -1 : rest.indexOf("```", open + 3);
    if (close === -1) break;
    nodes.push(...parseInline(rest.slice(0, open)));
    nodes.push({ kind: "mono", children: [{ kind: "text", text: rest.slice(open + 3, close) }] });
    rest = rest.slice(close + 3);
  }
  nodes.push(...parseInline(rest));
  return nodes;
}
