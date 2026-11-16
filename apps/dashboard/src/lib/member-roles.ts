import type { MemberRole } from "../members";

/** The roles an invitation or a role change may give. Owner is never offered. */
export const ROLE_OPTIONS: ReadonlyArray<{ value: MemberRole; label: string; description: string }> = [
  { value: "admin", label: "Admin", description: "Manages numbers, API keys, billing and members." },
  { value: "operator", label: "Operator", description: "Reads and replies to conversations." },
  { value: "viewer", label: "Viewer", description: "Reads only." },
];

const LABELS: Record<string, string> = { owner: "Owner", admin: "Admin", operator: "Operator", viewer: "Viewer" };

export const roleLabel = (role: string) => LABELS[role] ?? role;

export const isOwnerRole = (role: string) => role.split(",").includes("owner");
