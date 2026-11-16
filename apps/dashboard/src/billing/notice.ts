import { monthlyPriceEuros } from "./plan";

/**
 * Why a closed workspace cannot add a number, with the price a checkout started
 * now would charge. Without billing on this console there is no subscription to name.
 */
export function closedNotice(billing: boolean, numbers: number): string {
  if (!billing) return "This workspace cannot add new numbers.";
  const billed = Math.max(1, numbers);
  return `Adding a new number needs an active subscription: ${monthlyPriceEuros(billed)} EUR per month for ${billed} ${billed === 1 ? "number" : "numbers"}. The price follows the numbers you connect.`;
}
