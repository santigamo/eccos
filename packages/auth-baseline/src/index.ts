/**
 * Product-agnostic Better Auth organization baseline — extracted from the
 * Eccos customer-auth cut (eccos-0x0) per bead eccos-0x0.8.
 *
 * Shared here: configuration conventions, the capability model, and tenant
 * guards. Isolated per project: data (dedicated D1), secrets, email provider,
 * production bindings, and any product resource/account mapping.
 */

export {
  createOrgAuthConfig,
  type OrgAuthConfig,
  type OrgAuth,
} from "./config";
export {
  ac,
  owner,
  admin,
  operator,
  viewer,
  roles,
  defineProductStatement,
  type GatewayAction,
  GATEWAY_ACTIONS,
} from "./permissions";
export {
  resolveMemberships,
  verifyMembership,
  ForbiddenError,
  type Membership,
} from "./tenant";
export { resolveSession, requireSession, UnauthorizedError, type SessionUser } from "./session";
