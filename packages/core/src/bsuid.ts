/** A business-scoped user id: `US.13491208655302741918`, or `US.ENT.…` for a parent BSUID. */
const BSUID_PATTERN = /^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]{1,128}$/;

export function isBsuid(id: string): boolean {
  return BSUID_PATTERN.test(id);
}
