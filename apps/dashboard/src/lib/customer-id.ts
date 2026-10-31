import { isBsuid } from "@eccos/core/bsuid";

/**
 * A customer's id is their phone number, or the business-scoped user id (BSUID,
 * `US.1349…`, `CC.ENT.…`) Meta sends alone for a username user whose number it
 * withholds. The gateway accepts either wherever it takes a customer.
 */

const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{3,31}$/;

/**
 * A customer id as the URL and the server both take it: a BSUID verbatim, a
 * number as digits only, so "+34 600 ..." reads the same as "34600...", or
 * undefined.
 */
export function normalizeCustomerId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (isBsuid(trimmed)) return trimmed;
  return PHONE_PATTERN.test(trimmed) ? trimmed.replace(/\D/g, "") : undefined;
}

/** The full id as evidence shows it: a number the way a person dials it, a BSUID as Meta wrote it. */
export function formatCustomerId(id: string): string {
  return isBsuid(id) ? id : `+${id}`;
}

/** A BSUID shortened to its country and tail (`US.…741918`), for a title; a number in full. */
export function shortCustomerId(id: string): string {
  if (!isBsuid(id)) return `+${id}`;
  const dot = id.lastIndexOf(".");
  const tail = id.slice(dot + 1);
  return tail.length <= 8 ? id : `${id.slice(0, dot + 1)}…${tail.slice(-6)}`;
}
