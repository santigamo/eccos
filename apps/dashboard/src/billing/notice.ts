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
  return `Adding a new number needs an active subscription: ${monthlyPriceEuros(billed)} EUR per month for ${billed} ${billed === 1 ? "number" : "numbers"}. The price follows the numbers you connect.`;
}
