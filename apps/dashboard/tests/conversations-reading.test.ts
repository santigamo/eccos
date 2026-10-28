import { describe, expect, test } from "bun:test";
import {
  contactsOf,
  conversationsSearch,
  locationOf,
  mediaIdOf,
  mediaSrc,
  normalizeWaId,
  previewOf,
  relativeTime,
  senderLabelOf,
  threadEntries,
  uniqueBy,
} from "../src/lib/conversations";
import { keepLastGood } from "../src/hooks/use-last-good";
import { absorbNewest, appendOlder, bridgeTo, findInPages, startWalk } from "../src/lib/history";
import type { CursorPage, MessageRecord, Result } from "../src/server/gateway";

/**
 * How the conversation inbox READS stored messages (`src/lib/conversations.ts`)
 * and how "load older" and live refreshes merge pages (`src/lib/history.ts`,
 * `src/hooks/use-older-pages.ts`).
 *
 * The walk is tested as the hook runs it: pages are normalized to walk order
 * (newest first), then merged. Fixtures use reserved fake numbers (555-01xx)
 * and fake Meta ids only.
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

  test("a reaction lands on its target, and an empty one removes the sender's reaction", () => {
    const up = message({ id: "x-1", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1", emoji: "👍" } }), targetId: "t-1" });
    const removed = message({ id: "x-2", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1", emoji: "" } }), targetId: "t-1" });
    const entries = threadEntries([TEXT, up, removed]);
    expect(entries.map((entry) => entry.message.id)).toEqual(["t-1"]);
    expect(entries[0]?.reactions).toEqual([]);
  });

  test("one reaction per sender per message: the latest wins", () => {
    const first = message({ id: "x-1", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1", emoji: "👍" } }), targetId: "t-1", at: 2 });
    const second = message({ id: "x-2", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1", emoji: "❤️" } }), targetId: "t-1", at: 3 });
    expect(threadEntries([TEXT, first, second])[0]?.reactions).toEqual(["❤️"]);
  });

  test("the customer and the business are two senders, so each keeps its own reaction", () => {
    const customer = message({ id: "x-1", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1", emoji: "👍" } }), targetId: "t-1", at: 2 });
    const staff = message({ id: "x-2", direction: "out", type: "reaction", content: JSON.stringify({ reaction: { messageId: "t-1", emoji: "👍" } }), targetId: "t-1", at: 3 });
    expect(threadEntries([TEXT, customer, staff])[0]?.reactions).toEqual(["👍", "👍"]);
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
    expect(previewOf({ type: "image", text: null, direction: "echo", at: 1 })).toBe("You: Photo");
  });

  test("a preview with text or a caption shows it, and one without names its kind the way the thread does", () => {
    expect(previewOf({ type: "image", text: "Mira esto", direction: "in", at: 1 })).toBe("Mira esto");
    expect(previewOf({ type: "unsupported", text: null, direction: "in", at: 1 })).toBe("Unsupported message");
    expect(previewOf({ type: "location", text: null, direction: "in", at: 1 })).toBe("Location");
    expect(previewOf({ type: "order", text: null, direction: "in", at: 1 })).toBe("order");
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

describe("who sent a message", () => {
  test("only a live send through Eccos is 'Sent via Eccos'; an echo or an imported business reply is not", () => {
    expect(senderLabelOf({ direction: "in", origin: "live" })).toBe("Customer");
    expect(senderLabelOf({ direction: "out", origin: "live" })).toBe("Sent via Eccos");
    expect(senderLabelOf({ direction: "echo", origin: "live" })).toBe("Sent from the WhatsApp Business app");
    expect(senderLabelOf({ direction: "echo", origin: "history" })).toBe("Sent from the WhatsApp Business app");
    // A row an older build stored as an API send from history is still a business reply.
    expect(senderLabelOf({ direction: "out", origin: "history" })).toBe("Sent from the WhatsApp Business app");
  });
});

describe("conversations URL", () => {
  test("a bare id typed into the URL selects the thread, as a quoted one does", () => {
    // The router reads `?waId=34600111222` as a JSON number and `?waId="34600111222"` as text.
    expect(conversationsSearch({ waId: 34600111222, wabaId: 102938475647382 })).toEqual({
      waId: "34600111222",
      wabaId: "102938475647382",
    });
    expect(conversationsSearch({ waId: "34600111222", wabaId: "102938475647382" })).toEqual({
      waId: "34600111222",
      wabaId: "102938475647382",
    });
    expect(conversationsSearch({ waId: "+34 600 111 222" })).toEqual({ waId: "34600111222", wabaId: undefined });
    expect(conversationsSearch({ waId: "abc", wabaId: {} })).toEqual({ waId: undefined, wabaId: undefined });
  });
});

describe("numbers and dedupe", () => {
  test("a typed number is normalized to digits, so a pasted +34 number reads the same as the bare one", () => {
    expect(normalizeWaId("  15550100001 ")).toBe("15550100001");
    expect(normalizeWaId("+1 (555) 010-0001")).toBe("15550100001");
    expect(normalizeWaId("+34 600 000 001")).toBe("34600000001");
    expect(normalizeWaId("abc")).toBeUndefined();
    expect(normalizeWaId(undefined)).toBeUndefined();
  });

  test("a page that overlaps the one before keeps the first copy", () => {
    expect(uniqueBy(["a", "b", "a", "c"], (item) => item)).toEqual(["a", "b", "c"]);
  });
});

describe("walking pages", () => {
  const key = (item: string) => item;
  const page = (ids: string[], nextCursor: string | null): CursorPage<string> => ({ items: ids, nextCursor });
  const range = (from: number, to: number) => {
    const ids: string[] = [];
    for (let n = from; n >= to; n--) ids.push(`m${n}`);
    return ids;
  };

  test("a page loaded older follows what is loaded, and the cursor moves past it", () => {
    const newest = startWalk(page(["m50", "m49"], "c1"));
    const second = appendOlder(newest, page(["m48", "m47"], "c2"), key);
    expect(second).toEqual({ items: ["m50", "m49", "m48", "m47"], cursor: "c2" });
    expect(appendOlder(second, page(["m46"], null), key)).toEqual({
      items: ["m50", "m49", "m48", "m47", "m46"],
      cursor: null,
    });
  });

  test("a live refresh that still reaches the loaded top keeps the history below it", () => {
    const loaded = appendOlder(startWalk(page(["m50", "m49"], "c1")), page(["m48", "m47"], "c2"), key);
    const refreshed = absorbNewest(loaded, page(["m51", "m50"], "c9"), key);
    expect(refreshed).toEqual({ items: ["m51", "m50", "m49", "m48", "m47"], cursor: "c2" });
  });

  test("a refresh keeps loaded items the fresh page no longer carries", () => {
    const loaded = startWalk(page(range(50, 41), "c1"));
    const refreshed = absorbNewest(loaded, page(["m60", "m59", ...range(50, 42)], "c2"), key);
    expect(refreshed.items).toEqual([...range(60, 59), ...range(50, 41)]);
  });

  test("more new messages than one page holds bridge the gap before the refresh lands", async () => {
    const loaded = appendOlder(startWalk(page(["m50", "m49"], "c1")), page(["m48"], "c2"), key);
    const fresh = page(range(110, 61), "f1");
    const older: Record<string, CursorPage<string>> = {
      f1: page(range(60, 51), "f2"),
      f2: page(["m50", "m49"], "c1"),
    };
    const bridge = await bridgeTo(fresh, "m50", key, async (cursor) => ({ ok: true, data: older[cursor] as CursorPage<string> }));
    expect(bridge).toEqual({ ok: true, data: { items: range(60, 51), reachedTop: true } });
    const refreshed = absorbNewest(loaded, fresh, key, bridge.ok ? bridge.data : undefined);
    expect(refreshed.items).toEqual([...range(110, 51), "m50", "m49", "m48"]);
    expect(refreshed.cursor).toBe("c2");
  });

  test("when the old top has aged out, the walk is rebuilt from what is there and marked at its end", async () => {
    const loaded = startWalk(page(["m50", "m49"], "c1"));
    const fresh = page(range(110, 61), "f1");
    const older: Record<string, CursorPage<string>> = {
      f1: page(range(60, 51), "f2"),
      f2: page(["m40"], null),
    };
    const bridge = await bridgeTo(fresh, "m50", key, async (cursor) => ({ ok: true, data: older[cursor] as CursorPage<string> }));
    const refreshed = absorbNewest(loaded, fresh, key, bridge.ok ? bridge.data : undefined);
    expect(refreshed).toEqual({ items: [...range(110, 61), ...range(60, 51), "m40"], cursor: null });
  });

  test("a failed fetch while bridging is reported, not folded in", async () => {
    const fresh = page(range(110, 61), "f1");
    const bridge = await bridgeTo(fresh, "m50", key, async () => ({ ok: false, kind: "unreachable", error: "boom" }));
    expect(bridge).toEqual({ ok: false, kind: "unreachable", error: "boom" });
  });

  test("a number past the first page is found, within the page budget", async () => {
    const first = page(["m50", "m49"], "c1");
    const older = async (cursor: string): Promise<Result<CursorPage<string>>> => ({
      ok: true,
      data: cursor === "c1" ? page(["m40", "m39"], "c2") : page(["m30"], null),
    });
    expect(await findInPages(first, (item) => item === "m39", older, 5)).toBe("m39");
    expect(await findInPages(first, (item) => item === "m30", older, 2)).toBeUndefined();
  });
});

describe("a thread across two pages", () => {
  // The gateway returns each page oldest first and walks older with the cursor.
  // The hook keeps the walk newest first, so the reader sees the whole thread in order.
  const TWO_PAGE = {
    newest: [
      message({ id: "m3", text: "tres", at: 3 }),
      message({ id: "m4", text: "cuatro", at: 4 }),
      message({ id: "e2", type: "edit", targetId: "m2", text: "dos (segunda)", at: 6 }),
    ],
    older: [
      message({ id: "m1", text: "uno", at: 1 }),
      message({ id: "m2", text: "dos", at: 2 }),
      message({ id: "e1", type: "edit", targetId: "m2", text: "dos (primera)", at: 5 }),
    ],
  };
  const walkOrder = (items: MessageRecord[]) => [...items].reverse();
  const key = (item: MessageRecord) => item.id;

  test("the two pages read as one thread, oldest first, and the newest edit wins", () => {
    const newest = startWalk({ items: walkOrder(TWO_PAGE.newest), nextCursor: "older" });
    const walk = appendOlder(newest, { items: walkOrder(TWO_PAGE.older), nextCursor: null }, key);
    const chronological = [...walk.items].reverse();
    expect(chronological.map((row) => row.id)).toEqual(["m1", "m2", "e1", "m3", "m4", "e2"]);
    const entries = threadEntries(chronological);
    expect(entries.map((entry) => entry.message.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(entries[1]).toMatchObject({ text: "dos (segunda)", edited: true });
  });
});

describe("a failed refresh keeps what was shown", () => {
  const FAILURE = { ok: false as const, kind: "unreachable" as const, error: "boom" };

  test("a successful read is shown and becomes the last good one", () => {
    const { shown, good } = keepLastGood(null, { ok: true, data: "fresh" }, "acct:waba");
    expect(shown).toEqual({ ok: true, data: "fresh", failure: null });
    expect(good).toEqual({ scope: "acct:waba", data: "fresh" });
  });

  test("a failed refresh shows the last good data for the same scope, with the failure beside it", () => {
    const good = { scope: "acct:waba", data: "loaded" };
    const { shown, good: kept } = keepLastGood(good, FAILURE, "acct:waba");
    expect(shown).toEqual({ ok: true, data: "loaded", failure: FAILURE });
    expect(kept).toBe(good);
  });

  test("a failure in another scope has nothing to fall back on", () => {
    const good = { scope: "acct:other", data: "loaded" };
    expect(keepLastGood(good, FAILURE, "acct:waba").shown).toBe(FAILURE);
    expect(keepLastGood(null, FAILURE, "acct:waba").shown).toBe(FAILURE);
  });
});
