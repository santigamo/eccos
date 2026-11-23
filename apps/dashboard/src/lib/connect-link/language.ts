import { type ConnectLinkCopy, en } from "./en";
import { es } from "./es";

export type ConnectLinkLanguage = "en" | "es";

/** Spanish when `Accept-Language` ranks it above English; English otherwise. */
export function pickLanguage(acceptLanguage: string | null | undefined): ConnectLinkLanguage {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { primary: tag.trim().toLowerCase().split("-")[0], q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => (entry.primary === "es" || entry.primary === "en") && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked[0]?.primary === "es" ? "es" : "en";
}

export function copyFor(language: ConnectLinkLanguage): ConnectLinkCopy {
  return language === "es" ? es : en;
}
