import { monthlyPriceEuros } from "./plan";

/**
 * Why a closed workspace cannot add a number, priced for one more than it has.
 * Without billing on this console there is no subscription to name.
 */
export function closedNotice(billing: boolean, numbers: number): string {
  if (!billing) return "This workspace cannot add new numbers.";
  const next = numbers + 1;
  return `Adding a new number needs an active subscription: ${monthlyPriceEuros(next)} EUR per month for ${next} ${next === 1 ? "number" : "numbers"}.`;
}
