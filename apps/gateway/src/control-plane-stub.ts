import type { EccosControlPlane } from "./control-plane";
import { resolveDoJurisdiction } from "./gateway-stub";

export const CONTROL_PLANE_NAME = "control-plane";

export function getControlPlaneStub(env: {
  CONTROL_PLANE: DurableObjectNamespace<EccosControlPlane>;
  DO_JURISDICTION?: string;
}): DurableObjectStub<EccosControlPlane> {
  const jurisdiction = resolveDoJurisdiction(env);
  const namespace = jurisdiction ? env.CONTROL_PLANE.jurisdiction(jurisdiction) : env.CONTROL_PLANE;
  return namespace.get(namespace.idFromName(CONTROL_PLANE_NAME));
}
