import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { useState } from "react";

import type { ConversationSummary, CursorPage } from "../src/server/gateway";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useOlderPages } = await import("../src/hooks/use-older-pages");
const { useMarkOpenRead } = await import("../src/hooks/use-mark-open-read");

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const row = (waId: string, unreadCount: number): ConversationSummary => ({
  waId,
  name: null,
  messageCount: 1,
  unreadCount,
  markedUnread: false,
  lastMessage: { type: "text", text: "hi", direction: "in", at: 1000 },
});

const FIRST: CursorPage<ConversationSummary> = { items: [row("1", 0)], nextCursor: "next" };
const SECOND: CursorPage<ConversationSummary> = { items: [row("2", 3)], nextCursor: null };

describe("useMarkOpenRead", () => {
  test("an unread row on an older page is marked once, though a reload never refreshes it", async () => {
    let marks = 0;
    let loadOlder = () => {};
    let unreadOfOlder: number | undefined;

    function Probe({ selected }: { selected?: string }) {
      const [newest, setNewest] = useState(FIRST);
      const older = useOlderPages(newest, {
        key: (item) => item.waId,
        fetchOlder: async () => ({ ok: true, data: SECOND }),
      });
      loadOlder = older.loadOlder;
      unreadOfOlder = older.items.find((item) => item.waId === "2")?.unreadCount;
      useMarkOpenRead(older.items, selected, async ({ waId }) => {
        marks++;
        older.patch(
          (item) => item.waId === waId,
          (item) => ({ ...item, unreadCount: 0 }),
        );
        // A reload that lands after the guard is free: the same first page, without the older row.
        setTimeout(() => setNewest({ ...FIRST, items: [...FIRST.items] }), 1);
      });
      return null;
    }

    const host = document.createElement("div");
    const root = createRoot(host);
    const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 40))));
    try {
      await act(async () => root.render(<Probe />));
      await act(async () => loadOlder());
      await settle();
      expect(unreadOfOlder).toBe(3);

      await act(async () => root.render(<Probe selected="2" />));
      await settle();
      expect(marks).toBe(1);
      expect(unreadOfOlder).toBe(0);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
