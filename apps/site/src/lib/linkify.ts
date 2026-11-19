/**
 * Answers are stored as plain text, because the JSON-LD and /llms.txt quote
 * them verbatim. On the page, each URL or email address in them becomes a link;
 * a sentence-ending period stays outside it.
 */
const LINK = /(https?:\/\/[^\s),]*[^\s),.]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/;

export function linkify(text: string): { text: string; href?: string }[] {
  // split() with a capture group puts every match at an odd index.
  return text.split(LINK).map((part, i) => {
    if (i % 2 === 0) return { text: part };
    return { text: part, href: part.startsWith("http") ? part : `mailto:${part}` };
  });
}
