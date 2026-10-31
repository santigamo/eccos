export type SendPhase = "idle" | "sending" | "sent";

/**
 * Guards one composed payload against being sent twice. The phase lives in a
 * ref-like box rather than React state so a second submit in the same tick
 * (double click, Enter racing a click) sees it before any re-render.
 */
export interface SendGate {
  phase: SendPhase;
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
