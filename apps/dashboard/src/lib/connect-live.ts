import type { ConnectPath } from "./embedded-signup";

/**
 * What the console has actually observed of one Embedded Signup attempt, each
 * fact with the moment it was seen. Nothing here is estimated: Meta's window is
 * opaque, so its screens are one step that waits for the customer.
 *
 * - `openedAt`: the browser handed us Meta's window, or Meta's window posted a session event.
 * - `finishedAt`: Meta's FINISH session event, or `FB.login` returned a code.
 * - `connected`: the exchange registered the number (provisioning answered).
 */
export type ConnectLive = {
  launchedAt?: number;
  openedAt?: number;
  finishedAt?: number;
  connected?: { at: number; phone: string };
};

export type LiveState = "done" | "now" | "next";
export type LiveRow = { id: string; label: string; note?: string; state: LiveState; at?: number };

const SCREENS: Record<ConnectPath, string> = {
  "business-app": "Log in, choose your business, scan the code, old chats.",
  "new-number": "Log in, choose your business, your number and name, the code.",
};

/** The four facts, in order: done when observed, the first unobserved one is now. */
export function liveRows(live: ConnectLive, path: ConnectPath): LiveRow[] {
  const facts: { id: string; at?: number; label: [done: string, todo: string]; note?: string }[] = [
    { id: "opened", at: live.openedAt, label: ["Meta's window opened", "Meta's window opens"] },
    {
      id: "finished",
      at: live.finishedAt,
      label: ["You finished Meta's four screens", "You finish Meta's four screens"],
      note: `${SCREENS[path]} We cannot see inside Meta's window, so this one waits for you.`,
    },
    {
      id: "connected",
      at: live.connected?.at,
      label: ["Meta handed your number to Eccos", "Meta hands your number to Eccos"],
      note: "Automatic. It takes a few seconds.",
    },
    // Observed after this wizard ends (first 2xx delivery or first outbound delivered).
    {
      id: "first-message",
      at: undefined,
      label: ["Your first message went through", "Your first message goes through"],
      note: live.connected
        ? "One minute more. Choose what you want to do and we test it together."
        : "The last step. We do it together.",
    },
  ];
  const current = facts.findIndex((fact) => fact.at === undefined);
  return facts.map((fact, i) => {
    const state: LiveState = i < current || current === -1 ? "done" : i === current ? "now" : "next";
    return {
      id: fact.id,
      label: state === "done" ? fact.label[0] : fact.label[1],
      state,
      ...(state === "done" ? { at: fact.at } : fact.note ? { note: fact.note } : {}),
    };
  });
}

/** A fact's time, as the stepper prints it. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
