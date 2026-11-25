import { monthlyPriceEuros } from "./plan";

/**
 * Why a closed workspace cannot add a number, with the price a checkout started
 * now would charge. Without billing on this console there is no subscription to name.
 */
export function closedNotice(billing: boolean, numbers: number, canManage = true): string {
  if (!billing) return "This workspace cannot add new numbers.";
  // No price for a member who cannot start the subscription: it is not theirs to weigh.
  if (!canManage) {
    return "Adding a new number needs an active subscription. Ask an owner or admin of this workspace to start it.";
  }
  const billed = Math.max(1, numbers);
  return `Adding a new number needs an active subscription: ${monthlyPriceEuros(billed)} EUR per month + VAT for ${billed} ${billed === 1 ? "number" : "numbers"}. The price follows the numbers you connect.`;
}

/**
 * A workspace whose billing status blocks sends: sending and forwarding are paused,
 * receiving goes on. `messages` is how many are stored, unknown when the read failed.
 */
export function sendingPausedNotice(billing: boolean, canManage = true, messages?: number | null): string {
  const stored =
    messages == null
      ? "Incoming messages are stored safely."
      : `${messages} incoming ${messages === 1 ? "message is" : "messages are"} stored safely.`;
  const paused = `Sending and forwarding are paused. ${stored}`;
  if (!billing) return paused;
  return `${paused} ${canManage ? "Subscribe to resume." : "Ask an owner or admin of this workspace to subscribe."}`;
}
