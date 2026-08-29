/**
 * Capability model for the organization baseline.
 *
 * Five product actions covering the common console surface; rename the
 * `gateway` resource (via {@link defineProductStatement}) to match your
 * product. Role matrix shape (minimum role per action):
 *
 *   view       — read-only surfaces
 *   operate    — operational mutations (retry, read config)
 *   configure  — configuration mutations (write config, re-handshakes)
 *   administer — credential/connection administration (keys, OAuth, export)
 *   erase      — destructive data operations (GDPR erasure)
 *
 *   view: viewer+ | operate: operator+ | configure: admin+ |
 *   administer: admin+ | erase: owner
 */

import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const GATEWAY_ACTIONS = [
  "view",
  "operate",
  "configure",
  "administer",
  "erase",
] as const;

export type GatewayAction = (typeof GATEWAY_ACTIONS)[number];

/** Build the statement for a product resource with the five standard actions. */
export function defineProductStatement(resource: string) {
  return {
    ...defaultStatements,
    [resource]: GATEWAY_ACTIONS,
  } as const;
}

export const ac = createAccessControl({
  ...defaultStatements,
  gateway: GATEWAY_ACTIONS,
} as const);

export const viewer = ac.newRole({
  ...memberAc.statements,
  gateway: ["view"],
});

export const operator = ac.newRole({
  ...memberAc.statements,
  gateway: ["view", "operate"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  gateway: ["view", "operate", "configure", "administer"],
});

export const owner = ac.newRole({
  ...ownerAc.statements,
  gateway: ["view", "operate", "configure", "administer", "erase"],
});

export const roles = { owner, admin, operator, viewer };
