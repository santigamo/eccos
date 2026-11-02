import { describe, expect, test } from "bun:test";
import { sendKeyed, type SendGate } from "../src/lib/send-gate";

const SENT = { ok: true as const, data: { ok: true, messageId: "wamid.1" } };
const REFUSED = { ok: true as const, data: { ok: false, code: "graph" } };
const IN_PROGRESS = { ok: true as const, data: { ok: false, code: "in_progress" } };
const UNKNOWN = { ok: true as const, data: { ok: false, code: "unknown" } };
const UNREACHABLE = { ok: false as const };

/** A send that records the key of every call and answers with `answers` in turn. */
function recorder(...answers: Array<typeof SENT | typeof REFUSED | typeof IN_PROGRESS | typeof UNKNOWN | typeof UNREACHABLE | Error>) {
  const keys: string[] = [];
  const send = async (data: { idempotencyKey: string }) => {
    keys.push(data.idempotencyKey);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer ?? SENT;
  };
  return { keys, send };
}

describe("sendKeyed", () => {
  test("a retry after a throw, a boundary failure, unknown or in_progress reuses the key", async () => {
    const gate: SendGate = { phase: "idle" };
    const { keys, send } = recorder(new Error("timeout"), UNREACHABLE, UNKNOWN, IN_PROGRESS, SENT);
    await expect(sendKeyed(gate, { text: "hola" }, send)).rejects.toThrow("timeout");
    await sendKeyed(gate, { text: "hola" }, send);
    await sendKeyed(gate, { text: "hola" }, send);
    await sendKeyed(gate, { text: "hola" }, send);
    await sendKeyed(gate, { text: "hola" }, send);
    expect(new Set(keys).size).toBe(1);
  });

  test("a confirmed success starts a new intent, even for the same content", async () => {
    const gate: SendGate = { phase: "idle" };
    const { keys, send } = recorder(SENT, SENT);
    await sendKeyed(gate, { text: "hola" }, send);
    await sendKeyed(gate, { text: "hola" }, send);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a refusal the gateway answered for is settled: sending again is a new key", async () => {
    const gate: SendGate = { phase: "idle" };
    const { keys, send } = recorder(REFUSED, SENT);
    await sendKeyed(gate, { text: "hola" }, send);
    await sendKeyed(gate, { text: "hola" }, send);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("new content gets a new key while the old one is unsettled", async () => {
    const gate: SendGate = { phase: "idle" };
    const { keys, send } = recorder(UNREACHABLE, SENT);
    await sendKeyed(gate, { text: "hola" }, send);
    await sendKeyed(gate, { text: "hola!" }, send);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
