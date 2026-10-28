import { describe, expect, test } from "bun:test";
import {
  contactsOf,
  locationOf,
  mediaIdOf,
  mediaSrc,
  normalizeWaId,
  previewOf,
  relativeTime,
  threadEntries,
  uniqueBy,
} from "../src/lib/conversations";
import { olderCursor, takeOlderPage, type OlderPages } from "../src/hooks/use-older-pages";
import type { CursorPage, MessageRecord } from "../src/server/gateway";

/**
 * How the conversation inbox READS stored messages (`src/lib/conversations.ts`)
 * and how "load older" chains pages (`src/hooks/use-older-pages.ts`).
 *
 * Fixtures use reserved fake numbers (555-01xx) and fake Meta ids only.
 */

function message(overrides: Partial<MessageRecord> & Pick<MessageRecord, "id">): MessageRecord {
  return {
    waId: "15550100001",
    direction: "in",
    origin: "live",
    type: "text",
    text: null,
    content: null,
    at: 1_700_000_000_000,
    status: null,
    error: null,
    targetId: null,
    phoneNumberId: "phone-a",
    ...overrides,
  };
}

describe("media", () => {
  test("inbound media keeps its id under `media`; a send keeps it on the typed object", () => {
    const inbound = message({ id: "in-1", type: "image", content: JSON.stringify({ media: { id: "m-1" } }) });
    const outbound = message({ id: "out-1", type: "image", direction: "out", content: JSON.stringify({ id: "m-2" }) });
    expect(mediaIdOf(inbound)).toBe("m-1");
    expect(mediaIdOf(outbound)).toBe("m-2");
  });

  test("a send by link has no media to fetch, and a non-media row has none either", () => {
    const byLink = message({ id: "out-2", type: "image", direction: "out", content: JSON.stringify({ link: "https://example.test/a.jpg" }) });
    expect(mediaIdOf(byLink)).toBeNull();
    expect(mediaIdOf(message({ id: "t-1", type: "text", content: JSON.stringify({ id: "x" }) }))).toBeNull();
  });

  test("the media route is `/media/<wabaId>/<mediaId>`, and needs both ids", () => {
    expect(mediaSrc("waba-a", "m-1")).toBe("/media/waba-a/m-1");
    expect(mediaSrc(undefined, "m-1")).toBeNull();
    expect(mediaSrc("waba-a", null)).toBeNull();
  });

  test("a row whose content will not parse reads as having no media", () => {
    expect(mediaIdOf(message({ id: "bad", type: "image", content: "{not json" }))).toBeNull();
  });
});

describe("locations and contacts", () => {
  test("a location names its place and links to a map of its coordinates", () => {
    const location = locationOf(
      message({
        id: "loc-1",
        type: "location",
        content: JSON.stringify({ location: { latitude: 40.4, longitude: -3.7, name: "Consulta", address: "Calle Ejemplo 1" } }),
      }),
    );
    expect(location?.name).toBe("Consulta");
    expect(location?.address).toBe("Calle Ejemplo 1");
    expect(location?.mapHref).toContain("query=40.4,-3.7");
  });

  test("a contact card reduces to its name and numbers", () => {
    const [contact] = contactsOf(
      message({
        id: "c-1",
        type: "contacts",
        content: JSON.stringify({
          contacts: [{ name: { formatted_name: "Ana Ejemplo" }, phones: [{ phone: "+15550100003" }, {}] }],
        }),
      }),
    );
    expect(contact).toEqual({ name: "Ana Ejemplo", phones: ["+15550100003"] });
  });

  test("a contact with no name still reads as a contact", () => {
    const [contact] = contactsOf(message({ id: "c-2", type: "contacts", content: JSON.stringify({ contacts: [{}] }) }));
    expect(contact?.name).toBe("Unnamed contact");
  });
});

describe("threadEntries", () => {
  const TEXT = message({ id: "t-1", text: "Hola" });

  test("an edit folds into its target: the new text replaces the old and the target is marked", () => {
    const edit = message({ id: "e-1", type: "edit", text: "Hola, ¿qué tal?", targetId: "t-1", at: 1_700_000_005_000 });
    const entries = threadEntries([TEXT, edit]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: "Hola, ¿qué tal?", edited: true, deleted: false });
  });

  test("the newest edit wins, because the thread is in time order", () => {
    const first = message({ id: "e-1", type: "edit", text: "primera", targetId: "t-1", at: 2 });
    const second = message({ id: "e-2", type: "edit", text: "segunda", targetId: "t-1", at: 3 });
    expect(threadEntries([TEXT, first, second])[0]?.text).toBe("segunda");
  });

  test("a revoke marks its target deleted and stops being a row", () => {
    const revoke = message({ id: "r-1", type: "revoke", targetId: "t-1" });
    const entries = threadEntries([TEXT, revoke]);
    expect(entries.map((entry) => entry.message.id)).toEqual(["t-1"]);
    expect(entries[0]?.deleted).toBe(true);
  });

  test("a reaction lands on its target, and a removed reaction (no emoji) lands nowhere", () => {
    const up = message({ id: "x-1", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1", emoji: "👍" } }), targetId: "t-1" });
    const removed = message({ id: "x-2", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1" } }), targetId: "t-1" });
    const entries = threadEntries([TEXT, up, removed]);
    expect(entries.map((entry) => entry.message.id)).toEqual(["t-1"]);
    expect(entries[0]?.reactions).toEqual(["👍"]);
  });

  test("an act whose target is not in the page stays as its own row", () => {
    const orphanEdit = message({ id: "e-9", type: "edit", text: "nuevo", targetId: "gone" });
    const orphanReaction = message({ id: "x-9", type: "reaction", content: JSON.stringify({ reaction: { messageId: "gone", emoji: "🎉" } }), targetId: "gone" });
    const entries = threadEntries([orphanEdit, orphanReaction]);
    expect(entries.map((entry) => entry.message.id)).toEqual(["e-9", "x-9"]);
    expect(entries[0]?.edited).toBe(false);
  });
});

describe("previews and times", () => {
  test("the list's preview marks the staff's own sends and names a deletion", () => {
    expect(previewOf({ type: "text", text: "Hola", direction: "in", at: 1 })).toBe("Hola");
    expect(previewOf({ type: "text", text: "Te esperamos", direction: "out", at: 1 })).toBe("You: Te esperamos");
    expect(previewOf({ type: "revoke", text: null, direction: "in", at: 1 })).toBe("Message deleted");
    expect(previewOf({ type: "image", text: null, direction: "echo", at: 1 })).toBe("You: image");
  });

  test("the list's time is a short read, and the same moment across each unit", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 d ago");
    expect(relativeTime(now - 90 * 86_400_000, now)).toBe(new Date(now - 90 * 86_400_000).toISOString().slice(0, 10));
  });

  test("a timestamp in the future reads as just now, not as a negative age", () => {
    expect(relativeTime(2_000, 1_000)).toBe("just now");
  });
});

describe("numbers and dedupe", () => {
  test("a typed number is normalized the same way the server will read it", () => {
    expect(normalizeWaId("  15550100001 ")).toBe("15550100001");
    expect(normalizeWaId("+1 (555) 010-0001")).toBe("+1 (555) 010-0001");
    expect(normalizeWaId("abc")).toBeUndefined();
    expect(normalizeWaId(undefined)).toBeUndefined();
  });

  test("a page that overlaps the one before keeps the first copy", () => {
    expect(uniqueBy(["a", "b", "a", "c"], (item) => item)).toEqual(["a", "b", "c"]);
  });
});

describe("load older", () => {
  const page = (ids: string[], nextCursor: string | null): CursorPage<string> => ({ items: ids, nextCursor });
  const NONE: OlderPages<string> = { items: [], cursor: undefined };

  test("the first older request starts from the newest page's cursor", () => {
    expect(olderCursor(NONE, page(["a"], "c1"))).toBe("c1");
    expect(olderCursor(NONE, page(["a"], null))).toBeNull();
  });

  test("each older page continues from the last one loaded, not from the newest", () => {
    const newest = page(["m50", "m49"], "c1");
    const second = takeOlderPage(NONE, page(["m48", "m47"], "c2"));
    expect(olderCursor(second, newest)).toBe("c2");
    const third = takeOlderPage(second, page(["m46"], null));
    expect(third.items).toEqual(["m48", "m47", "m46"]);
    expect(olderCursor(third, newest)).toBeNull();
  });

  test("a live refresh moves the newest page without losing the history already loaded", () => {
    const loaded = takeOlderPage(NONE, page(["m48"], "c2"));
    const refreshed = page(["m51", "m50"], "c9");
    expect(olderCursor(loaded, refreshed)).toBe("c2");
    expect(loaded.items).toEqual(["m48"]);
  });
});
