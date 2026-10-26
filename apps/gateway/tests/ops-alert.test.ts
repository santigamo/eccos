import { describe, expect, spyOn, test } from "bun:test";
import { sendOpsAlert } from "../src/ops-alert";

const ENV = {
  OPS_TELEGRAM_BOT_TOKEN: "123:test-token-not-real",
  OPS_TELEGRAM_CHAT_ID: "-1000000000001",
  OPS_TELEGRAM_THREAD_ID: "42",
};

function telegramReply(threadId: number, status = 200): Response {
  return Response.json({ ok: status === 200, result: { message_thread_id: threadId } }, { status });
}

describe("sendOpsAlert (eccos-r8x0)", () => {
  test("stays off unless all three secrets are set", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async (...args: unknown[]) => {
      calls.push(args);
      return telegramReply(42);
    }) as typeof fetch;
    expect(await sendOpsAlert({}, "x", fetchImpl)).toBe("disabled");
    expect(await sendOpsAlert({ ...ENV, OPS_TELEGRAM_THREAD_ID: "" }, "x", fetchImpl)).toBe("disabled");
    expect(await sendOpsAlert({ ...ENV, OPS_TELEGRAM_CHAT_ID: " " }, "x", fetchImpl)).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  test("posts plain text to the configured topic, once", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return telegramReply(42);
    }) as unknown as typeof fetch;
    expect(await sendOpsAlert(ENV, "deliveries are failing", fetchImpl)).toBe("sent");
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe("https://api.telegram.org/bot123:test-token-not-real/sendMessage");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: "-1000000000001", message_thread_id: 42, text: "deliveries are failing" });
    expect(body.parse_mode).toBeUndefined();
  });

  test("a reply from the wrong thread counts as failed (it landed in General)", async () => {
    const fetchImpl = (async () => telegramReply(1)) as unknown as typeof fetch;
    expect(await sendOpsAlert(ENV, "x", fetchImpl)).toBe("failed");
  });

  test("never throws, never retries, never logs the token", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("connection to https://api.telegram.org/bot123:test-token-not-real failed");
    }) as unknown as typeof fetch;
    expect(await sendOpsAlert(ENV, "x", fetchImpl)).toBe("failed");
    expect(calls).toBe(1);
    const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).not.toContain("test-token-not-real");
    warn.mockRestore();
  });
});
