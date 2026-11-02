export type SendPhase = "idle" | "sending" | "sent";

/**
 * Guards one composed payload against being sent twice. The phase lives in a
 * ref-like box rather than React state so a second submit in the same tick
 * (double click, Enter racing a click) sees it before any re-render.
 */
export interface SendGate {
  phase: SendPhase;
  /** The idempotency key of the payload awaiting the gateway's answer (see {@link sendKeyed}). */
  intent?: { key: string; payload: string };
}

/**
 * Runs `send` only from `idle`. Success is terminal: the gate stays `sent`
 * until the caller resets it on an explicit act. Failure returns to `idle`, so
 * a refused send stays retryable. Returns whether `send` ran.
 */
export async function runSend(gate: SendGate, send: () => Promise<boolean>): Promise<boolean> {
  if (gate.phase !== "idle") return false;
  gate.phase = "sending";
  let sent = false;
  try {
    sent = await send();
  } finally {
    gate.phase = sent ? "sent" : "idle";
  }
  return true;
}

type Answer = { ok: true; data: { ok: boolean; code?: string } } | { ok: false };

/**
 * Sends `payload` under one idempotency key per send intent. The key is reused
 * while the gateway has not answered for it (a throw, a boundary failure,
 * `in_progress`, `unknown`), so a retry cannot send twice; it is dropped once the gateway
 * answers or the payload changes, so the next send is a new message.
 */
export async function sendKeyed<P extends object, R extends Answer>(
  gate: SendGate,
  payload: P,
  send: (data: P & { idempotencyKey: string }) => Promise<R>,
): Promise<R> {
  const json = JSON.stringify(payload);
  if (gate.intent?.payload !== json) gate.intent = { key: crypto.randomUUID(), payload: json };
  const result = await send({ ...payload, idempotencyKey: gate.intent.key });
  if (result.ok && result.data.code !== "in_progress" && result.data.code !== "unknown") gate.intent = undefined;
  return result;
}
