import { describe, expect, test } from "bun:test";
import { en } from "../src/lib/connect-link/en";
import { es } from "../src/lib/connect-link/es";
import { copyFor, pickLanguage } from "../src/lib/connect-link/language";
import { linkIsLive, linkStatusLine } from "../src/lib/connect-link/status";
import { takeLinkToken } from "../src/lib/connect-link/token";

describe("pickLanguage", () => {
  test("Spanish only when the browser ranks it above English", () => {
    expect(pickLanguage("es-ES,es;q=0.9,en;q=0.8")).toBe("es");
    expect(pickLanguage("ca-ES,ca;q=0.9,es;q=0.8,en;q=0.7")).toBe("es");
    expect(pickLanguage("es")).toBe("es");
    expect(pickLanguage("en-GB,en;q=0.9,es;q=0.8")).toBe("en");
    expect(pickLanguage("en;q=0.5, es;q=0.9")).toBe("es");
    expect(pickLanguage("es;q=0, en")).toBe("en");
  });

  test("English for anything else", () => {
    for (const header of [null, undefined, "", "fr-FR,fr;q=0.9", "*", "garbage;;q=x"]) {
      expect(pickLanguage(header)).toBe("en");
    }
  });
});

describe("the two languages", () => {
  test("carry the same keys, and every string is filled in", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(es.before).toHaveLength(en.before.length);
    expect(copyFor("es")).toBe(es);
    expect(copyFor("en")).toBe(en);
    expect(es.gone("Rubén")).toContain("Rubén");
    expect(es.connected(null, "NACEX")).toContain("NACEX");
  });
});

describe("linkStatusLine", () => {
  const link = { expiresAt: 1, connectedPhone: null, creatorUserId: "user_ruben" };
  test("reads each state the way the dialog says it", () => {
    expect(linkStatusLine({ ...link, state: "pending" })).toBe("Not opened yet");
    expect(linkStatusLine({ ...link, state: "opened" })).toBe("Opened, not finished");
    expect(linkStatusLine({ ...link, state: "connected", connectedPhone: "+34 600 000 222" })).toBe(
      "Connected +34 600 000 222",
    );
    expect(linkStatusLine({ ...link, state: "connected" })).toBe("Connected");
    expect(linkStatusLine({ ...link, state: "expired" })).toBe("Expired");
    expect(linkStatusLine({ ...link, state: "unconfirmed" })).toContain("not confirmed");
    expect(linkIsLive({ ...link, state: "unconfirmed" })).toBe(false);
    expect(linkIsLive({ ...link, state: "opened" })).toBe(true);
    expect(linkIsLive({ ...link, state: "connected" })).toBe(false);
  });
});

describe("takeLinkToken", () => {
  function win(hash: string, stored: string | null = null) {
    const store = new Map<string, string>(stored ? [["eccos.connect-link", stored]] : []);
    const replaced: string[] = [];
    const fake = {
      location: { hash, pathname: "/connect", search: "" },
      history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    };
    return { fake: fake as unknown as Window, replaced };
  }

  test("takes the token out of the address bar and keeps it for a reload", () => {
    const first = win("#abc.def");
    expect(takeLinkToken(first.fake)).toBe("abc.def");
    expect(first.replaced).toEqual(["/connect"]);
    expect(takeLinkToken(win("", "abc.def").fake)).toBe("abc.def");
    expect(takeLinkToken(win("").fake)).toBeNull();
  });

  test("leaves the address bar clean even when storage refuses", () => {
    const blocked = win("#abc.def");
    (blocked.fake as unknown as { sessionStorage: unknown }).sessionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage is blocked");
      },
    };
    expect(takeLinkToken(blocked.fake)).toBe("abc.def");
    expect(blocked.replaced).toEqual(["/connect"]);
  });
});
