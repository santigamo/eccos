/**
 * Role/capability model for the customer dashboard (contract §4).
 *
 * Better Auth's Organization plugin provides identity-plane RBAC; this module
 * defines the Eccos access controller and the four organization roles mapped
 * onto the contract's role matrix. `gateway` is the Eccos-specific resource:
 *
 *   view       — read status, logs (inbound/outbound/deliveries), templates
 *   operate    — retry delivery, read subscriber config
 *   configure  — write subscriber config, resubscribe webhook, re-check a
 *                number's provisioning
 *   administer — API key management, Embedded Signup (/connect), export data
 *   erase      — GDPR erasure (eraseByPhone)
 *
 * Role matrix (minimum role per action):
 *   view: viewer+ | operate: operator+ | configure: admin+ |
 *   administer: admin+ | erase: owner
 *
 * Membership + permission checks are re-evaluated on every server operation
 * (contract §5); the browser-supplied org selection is never evidence.
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

export const statement = {
  ...defaultStatements,
  gateway: GATEWAY_ACTIONS,
} as const;

export const ac = createAccessControl(statement);

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
