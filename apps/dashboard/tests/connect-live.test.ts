import { describe, expect, test } from "bun:test";
import { liveRows } from "../src/lib/connect-live";

/**
 * The live connection status moves only on facts the console observed
 * (docs: Paper "0.3 · Nota: estado en vivo"). These pin that each row is done
 * only with its fact, carries that fact's time, and that nothing runs ahead.
 */
const states = (rows: ReturnType<typeof liveRows>) => rows.map((row) => row.state);

describe("liveRows", () => {
  test("before Meta's window is seen, the first fact is now and nothing is done", () => {
    expect(states(liveRows({ launchedAt: 1 }, "business-app"))).toEqual(["now", "next", "next", "next"]);
  });

  test("an observed window is done with its time, and Meta's screens wait for the customer", () => {
    const rows = liveRows({ launchedAt: 1, openedAt: 1_000 }, "business-app");
    expect(states(rows)).toEqual(["done", "now", "next", "next"]);
    expect(rows[0]).toMatchObject({ label: "Meta's window opened", at: 1_000 });
    expect(rows[1]?.note).toContain("scan the code");
    expect(rows[1]?.note).toContain("this one waits for you");
  });

  test("the new-number path names its own screens", () => {
    expect(liveRows({ openedAt: 1 }, "new-number")[1]?.note).toContain("your number and name, the code");
  });

  test("Meta's answer is done, the hand-over is now", () => {
    expect(states(liveRows({ openedAt: 1, finishedAt: 2 }, "new-number"))).toEqual(["done", "done", "now", "next"]);
  });

  test("a registered number leaves only the first message, which this wizard never marks done", () => {
    const rows = liveRows({ openedAt: 1, finishedAt: 2, connected: { at: 3, phone: "+1" } }, "business-app");
    expect(states(rows)).toEqual(["done", "done", "done", "now"]);
    expect(rows[2]).toMatchObject({ label: "Meta handed your number to Eccos", at: 3 });
    expect(rows[3]?.note).toContain("we test it together");
  });

  test("a fact is never shown done ahead of the one before it", () => {
    expect(states(liveRows({ finishedAt: 2 }, "business-app"))).toEqual(["now", "next", "next", "next"]);
  });
});
