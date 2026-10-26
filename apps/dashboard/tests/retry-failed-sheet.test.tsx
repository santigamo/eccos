import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The "Retry failed" sheet on the forwarding queue
 * (`components/logs/retry-failed-sheet.tsx`, rules in `lib/retry-window.ts`).
 *
 * WHAT IS RENDERED AND WHY. A closed Base UI dialog renders nothing, so the
 * sheet itself is never the subject of a markup assertion (the first test pins
 * that). `RetryFailedFields` is controlled, like `CreateTemplateFields`, so
 * every state renders without a browser. What a static frame cannot do is click
 * the button, so the request a click builds is asserted through
 * `submitRetryFailed` with a spy for the server function: that is the function
 * `RetryFailedForm`'s submit handler calls, with the form's own two strings.
 *
 * Importing the component pulls in `src/server/gateway.ts`, which imports
 * `cloudflare:workers` and `@tanstack/react-start`, mocked BEFORE the import
 * through the shared helper, whose header explains why it must be shared.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const {
  NoticeBody,
  RetryFailedFields,
  RetryFailedForm,
  RetryFailedSheet,
  describeWindow,
  refusesClose,
} = await import("../src/components/logs/retry-failed-sheet");
const {
  DEFAULT_WINDOW_DAYS,
  defaultWindowInputs,
  parseLocalInput,
  readWindow,
  retryResultLines,
  submitRetryFailed,
  toLocalInputValue,
} = await import("../src/lib/retry-window");

type Notice = Parameters<typeof NoticeBody>[0]["notice"];

const noop = () => {};
const DAY = 86_400_000;
const MINUTE = 60_000;

/** A local wall-clock moment, built the way a person reads one. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

function render(
  props: Partial<Parameters<typeof RetryFailedFields>[0]> = {},
  notice: Notice | null = null,
): string {
  return renderToStaticMarkup(
    <RetryFailedFields
      from="2026-10-19T08:00"
      to="2026-10-26T10:30"
      onFromChange={noop}
      onToChange={noop}
      submitting={false}
      notice={notice}
      onSubmit={noop}
      {...props}
    />,
  );
}

/**
 * Is the SUBMIT button disabled? Read off the button's own attributes: every
 * control here carries `disabled:*` Tailwind variants in its class string, so a
 * loose /disabled/ match passes on markup where nothing is disabled.
 */
function submitDisabled(html: string): boolean {
  const start = html.indexOf('<button type="submit"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(">", start)).includes('disabled=""');
}

const RETRY_WINDOW_MODULE = new URL("../src/lib/retry-window.ts", import.meta.url).pathname;

/**
 * `readWindow` as it answers in another time zone. `bun test` pins the process
 * to UTC and ignores a later `process.env.TZ`, so a zone other than the
 * runner's needs a process of its own: the module is pure, so it imports bare.
 */
function readWindowIn(timeZone: string, from: string, to: string) {
  const script = `import { readWindow } from ${JSON.stringify(RETRY_WINDOW_MODULE)};
console.log(JSON.stringify(readWindow(${JSON.stringify(from)}, ${JSON.stringify(to)})));`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, TZ: timeZone },
  });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString());
}

describe("local date-times to the window that is submitted", () => {
  test("a picked local date-time is the epoch-ms instant of that wall-clock moment", () => {
    expect(parseLocalInput("2026-10-19T08:00")).toBe(local(2026, 10, 19, 8, 0));
    expect(toLocalInputValue(local(2026, 10, 19, 8, 5))).toBe("2026-10-19T08:05");
    // Round trip, so the default the sheet writes is the value it later reads.
    const now = local(2026, 3, 1, 23, 59);
    expect(parseLocalInput(toLocalInputValue(now))).toBe(now);
  });

  test("the conversion follows the viewer's time zone, not the runner's", () => {
    // India is UTC+5:30 with no daylight saving, so 10:30 there is 05:00 UTC.
    // Without this the assertions above would hold in any zone, including a
    // converter that quietly read the string as UTC.
    expect(readWindowIn("Asia/Kolkata", "2026-10-26T10:30", "2026-10-26T10:30")).toEqual({
      ok: true,
      window: { from: Date.UTC(2026, 9, 26, 5, 0), to: Date.UTC(2026, 9, 26, 5, 0) + MINUTE - 1 },
    });
    // New York is on EDT (UTC-4) that day, and on EST (UTC-5) a week later.
    expect(readWindowIn("America/New_York", "2026-10-26T10:30", "2026-11-02T10:30")).toEqual({
      ok: true,
      window: { from: Date.UTC(2026, 9, 26, 14, 30), to: Date.UTC(2026, 10, 2, 15, 30) + MINUTE - 1 },
    });
  });

  test("From starts its minute and To includes its whole minute, both inclusive", () => {
    const read = readWindow("2026-10-19T08:00", "2026-10-26T10:30");
    expect(read).toEqual({
      ok: true,
      window: { from: local(2026, 10, 19, 8, 0), to: local(2026, 10, 26, 10, 30) + MINUTE - 1 },
    });
    // A batch enqueued at 10:30:20 sits inside "to 10:30".
    if (read.ok) expect(local(2026, 10, 26, 10, 30) + 20_000).toBeLessThanOrEqual(read.window.to);
  });

  test("the same minute is a valid one-minute window", () => {
    const read = readWindow("2026-10-26T10:30", "2026-10-26T10:30");
    expect(read.ok && read.window.to - read.window.from).toBe(MINUTE - 1);
  });

  test("an inverted window is refused with a sentence, and so is a missing end", () => {
    expect(readWindow("2026-10-26T10:31", "2026-10-26T10:30")).toEqual({
      ok: false,
      reason: "The window has to end after it starts.",
    });
    expect(readWindow("", "2026-10-26T10:30")).toEqual({
      ok: false,
      reason: "Choose the date and time the window starts.",
    });
    expect(readWindow("2026-10-26T10:30", "")).toEqual({
      ok: false,
      reason: "Choose the date and time the window ends.",
    });
  });

  test("a date that does not exist is not read as the one it rolls over into", () => {
    expect(parseLocalInput("2026-02-31T10:00")).toBeNull();
    expect(parseLocalInput("2026-10-26T24:00")).toBeNull();
    expect(parseLocalInput("2026-10-26")).toBeNull();
    expect(parseLocalInput("not a date")).toBeNull();
  });

  test("the sheet opens on the last seven days, up to now", () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(7);
    const now = new Date(2026, 9, 26, 12, 34, 56, 789).getTime();
    const { from, to } = defaultWindowInputs(now);
    const minuteOf = (ms: number) => {
      const d = new Date(ms);
      d.setSeconds(0, 0);
      return d.getTime();
    };
    expect(parseLocalInput(from)).toBe(minuteOf(now - 7 * DAY));
    expect(parseLocalInput(to)).toBe(minuteOf(now));
    // And the default is itself a valid window that reaches `now`.
    const read = readWindow(from, to);
    expect(read.ok && read.window.to).toBeGreaterThanOrEqual(now);
  });
});

describe("submitRetryFailed", () => {
  const ok = (requeued: number, skippedRedacted: number) =>
    Promise.resolve({ ok: true as const, data: { requeued, skippedRedacted } });

  test("submits the converted window and the WABA the page passed", async () => {
    const calls: unknown[] = [];
    const notice = await submitRetryFailed(
      { wabaId: "waba-a", fromInput: "2026-10-19T08:00", toInput: "2026-10-26T10:30" },
      (arg) => {
        calls.push(arg);
        return ok(790, 3);
      },
    );
    expect(calls).toEqual([
      {
        data: {
          wabaId: "waba-a",
          from: local(2026, 10, 19, 8, 0),
          to: local(2026, 10, 26, 10, 30) + MINUTE - 1,
        },
      },
    ]);
    expect(notice).toEqual({ ok: true, requeued: 790, skippedRedacted: 3 });
  });

  test("an unreadable window sends nothing", async () => {
    let called = false;
    const notice = await submitRetryFailed(
      { wabaId: "waba-a", fromInput: "2026-10-26T10:31", toInput: "2026-10-26T10:30" },
      () => {
        called = true;
        return ok(0, 0);
      },
    );
    expect(called).toBe(false);
    expect(notice).toEqual({
      ok: false,
      title: "Check the window",
      detail: "The window has to end after it starts.",
    });
  });

  test("a role without operate reads as that, not as an outage", async () => {
    const notice = await submitRetryFailed(
      { wabaId: "waba-a", fromInput: "2026-10-19T08:00", toInput: "2026-10-26T10:30" },
      () =>
        Promise.resolve({
          ok: false as const,
          kind: "forbidden" as const,
          reason: "missing-permission" as const,
          error: 'missing "operate" permission in this organization',
        }),
    );
    expect(notice).toMatchObject({ ok: false, title: "Not available to your role" });
    expect(JSON.stringify(notice)).not.toContain("unreachable");
  });

  test("an unreachable gateway says so, with the message it has", async () => {
    const notice = await submitRetryFailed(
      { wabaId: "waba-a", fromInput: "2026-10-19T08:00", toInput: "2026-10-26T10:30" },
      () => Promise.resolve({ ok: false as const, kind: "unreachable" as const, error: "boom" }),
    );
    expect(notice).toEqual({ ok: false, title: "Gateway unreachable", detail: "boom" });
  });

  test("a rejection becomes a notice instead of an unhandled promise", async () => {
    const notice = await submitRetryFailed(
      { wabaId: "waba-a", fromInput: "2026-10-19T08:00", toInput: "2026-10-26T10:30" },
      () => Promise.reject(new Error("from must not be after to")),
    );
    expect(notice).toEqual({
      ok: false,
      title: "The request did not go through",
      detail: "from must not be after to",
    });
  });
});

describe("the result's wording", () => {
  test("counts what was queued, and only mentions the rest when there is a rest", () => {
    expect(retryResultLines({ requeued: 790, skippedRedacted: 0 })).toEqual({
      headline: "790 deliveries queued again",
      notes: [],
    });
    expect(retryResultLines({ requeued: 790, skippedRedacted: 12 })).toEqual({
      headline: "790 deliveries queued again",
      notes: ["12 could not be replayed: their content is past the retention window."],
    });
  });

  test("one is singular, in both lines", () => {
    expect(retryResultLines({ requeued: 1, skippedRedacted: 1 })).toEqual({
      headline: "1 delivery queued again",
      notes: ["1 could not be replayed: its content is past the retention window."],
    });
  });

  test("an empty window says it found nothing, rather than leave a bare zero", () => {
    expect(retryResultLines({ requeued: 0, skippedRedacted: 0 })).toEqual({
      headline: "0 deliveries queued again",
      notes: ["No failed deliveries were enqueued in this window."],
    });
    // Nothing queued but some skipped is a different fact, and keeps its own line.
    expect(retryResultLines({ requeued: 0, skippedRedacted: 4 }).notes).toEqual([
      "4 could not be replayed: their content is past the retention window.",
    ]);
  });

  test("the result renders both counts, and the retention line only when it applies", () => {
    const withSkips = renderToStaticMarkup(
      <NoticeBody notice={{ ok: true, requeued: 790, skippedRedacted: 12 }} />,
    );
    expect(withSkips).toContain("790 deliveries queued again");
    expect(withSkips).toContain(
      "12 could not be replayed: their content is past the retention window.",
    );
    const clean = renderToStaticMarkup(
      <NoticeBody notice={{ ok: true, requeued: 790, skippedRedacted: 0 }} />,
    );
    expect(clean).toContain("790 deliveries queued again");
    expect(clean).not.toContain("could not be replayed");
  });

  test("an error renders its title and detail inline, in the destructive ink", () => {
    const html = renderToStaticMarkup(
      <NoticeBody
        notice={{ ok: false, title: "Not available to your role", detail: "Ask an admin." }}
      />,
    );
    expect(html).toContain("Not available to your role");
    expect(html).toContain("Ask an admin.");
    expect(html).toContain("text-[#ff7777]");
  });
});

describe("RetryFailedFields", () => {
  test("a closed Sheet renders nothing, which is why these tests render the fields", () => {
    expect(
      renderToStaticMarkup(
        <RetryFailedSheet open={false} onOpenChange={noop} wabaId="waba-a" />,
      ),
    ).toBe("");
  });

  test("two date-time fields in local time, holding the values it was given", () => {
    const html = render();
    expect(html).toContain('id="retry-failed-from"');
    expect(html).toContain('id="retry-failed-to"');
    expect(html.match(/type="datetime-local"/g)).toHaveLength(2);
    expect(html).toContain('value="2026-10-19T08:00"');
    expect(html).toContain('value="2026-10-26T10:30"');
    expect(html).toMatch(/<label[^>]*for="retry-failed-from"[^>]*>\s*From\s*<\/label>/);
    expect(html).toMatch(/<label[^>]*for="retry-failed-to"[^>]*>\s*To\s*<\/label>/);
  });

  test("says what the act does, in one plain paragraph", () => {
    const html = render();
    expect(html).toContain("Sends every failed delivery enqueued in this window again.");
    expect(html).toContain("x-idempotency-key");
    expect(html).toContain("so your receiver can drop repeats.");
    expect(html).toContain("Older events arrive late.");
  });

  test("reads the window back in UTC, the way the Enqueued column does", () => {
    const html = render();
    const read = readWindow("2026-10-19T08:00", "2026-10-26T10:30");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(html).toContain(describeWindow(read.window));
      expect(describeWindow(read.window)).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC to \d{4}-\d{2}-\d{2} \d{2}:\d{2}:59 UTC$/,
      );
    }
    expect(html).toContain("Both are your local time");
  });

  test("the confirm button is the verb, and is on for a valid window", () => {
    const html = render();
    expect(html).toContain("Retry failed deliveries");
    expect(submitDisabled(html)).toBe(false);
  });

  test("while pending the button is disabled and says so", () => {
    const html = render({ submitting: true });
    expect(submitDisabled(html)).toBe(true);
    expect(html).toContain("Retrying…");
    expect(html).toContain('aria-busy="true"');
  });

  test("an inverted or empty window turns the button off and puts the reason on screen", () => {
    const inverted = render({ from: "2026-10-26T10:31", to: "2026-10-26T10:30" });
    expect(submitDisabled(inverted)).toBe(true);
    expect(inverted).toContain("The window has to end after it starts.");
    expect(inverted).not.toContain("Both are your local time");

    const empty = render({ from: "" });
    expect(submitDisabled(empty)).toBe(true);
    expect(empty).toContain("Choose the date and time the window starts.");
  });

  test("the result sits in a live region that is mounted before it has anything to say", () => {
    const quiet = render();
    expect(quiet).toContain('<output aria-live="polite" aria-atomic="true"></output>');
    const done = render({}, { ok: true, requeued: 790, skippedRedacted: 12 });
    expect(done).toContain("790 deliveries queued again");
    expect(done).toContain("could not be replayed");
    const refused = render({}, { ok: false, title: "Signed out", detail: "Sign in again." });
    expect(refused).toContain("Signed out");
  });

  test("design contract: square, machine-voice labels, dark native picker, no em dash", () => {
    const html = render({}, { ok: true, requeued: 1, skippedRedacted: 0 });
    expect(html).toContain("rounded-none");
    expect(html).toContain("text-[11px]");
    expect(html).toContain("uppercase");
    expect(html).toContain("[color-scheme:dark]");
    expect(html).not.toContain("rounded-md");
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("RetryFailedForm", () => {
  test("opens on a week ending now, in the two fields", () => {
    const before = Date.now();
    const html = renderToStaticMarkup(<RetryFailedForm wabaId="waba-a" />);
    const after = Date.now();
    const values = [...html.matchAll(/type="datetime-local"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*type="datetime-local"/g)]
      .map((m) => m[1] ?? m[2] ?? "");
    expect(values).toHaveLength(2);
    const [from, to] = values.map((v) => parseLocalInput(v));
    // Minute resolution: the default can sit up to a minute under the clock.
    expect(to).toBeGreaterThan(before - MINUTE);
    expect(to).toBeLessThanOrEqual(after);
    expect((to as number) - (from as number)).toBeGreaterThanOrEqual(7 * DAY - 61 * MINUTE);
    expect((to as number) - (from as number)).toBeLessThanOrEqual(7 * DAY + 61 * MINUTE);
  });
});

describe("dismissing the sheet", () => {
  test("Escape is refused while a replay is in flight, and only then", () => {
    expect(refusesClose({ submitting: true, reason: "escape-key" })).toBe(true);
    expect(refusesClose({ submitting: false, reason: "escape-key" })).toBe(false);
  });

  test("the close button is never refused, so leaving always stays possible", () => {
    expect(refusesClose({ submitting: true, reason: "close-press" })).toBe(false);
    expect(refusesClose({ submitting: false, reason: "close-press" })).toBe(false);
  });
});
