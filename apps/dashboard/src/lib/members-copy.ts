/**
 * What the Members screen may say about a failure. Allowlisted by error code
 * (`members.ts` maps a thrown error to one of these); the provider's own text
 * never reaches the page.
 */
export const MEMBERS_RETRY = "Could not update the workspace members right now. Please try again.";
export const MEMBERS_SIGNED_OUT = "Your session has expired. Sign in again to manage members.";

/** Shown to a member whose role may not manage members, on the page and on every refusal. */
export const ASK_TO_MANAGE_MEMBERS = "Ask an owner or admin of this workspace to manage members.";

// One sentence for "not found" and "in another workspace": telling them apart
// would confirm that an id exists somewhere else.
export const MEMBER_GONE = "This person is no longer a member of this workspace. Reload to see the current list.";
export const INVITATION_GONE = "This invitation is no longer pending. Reload to see the current list.";

/** Codes the members module raises itself, before Better Auth is asked. */
export const OWNER_PROTECTED = "OWNER_PROTECTED";
export const LAST_OWNER = "LAST_OWNER";
export const INVITATION_RATE_LIMITED = "INVITATION_RATE_LIMITED";
export const ROLE_NOT_OFFERED = "ROLE_NOT_OFFERED";
export const WORKSPACE_CHANGED = "WORKSPACE_CHANGED";

export const MEMBERS_COPY: Record<string, string> = {
  UNAUTHORIZED: MEMBERS_SIGNED_OUT,
  [OWNER_PROTECTED]: "Only an owner can change or remove another owner.",
  [LAST_OWNER]: "A workspace needs at least one owner. Make someone else an owner first.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER:
    "A workspace needs at least one owner. Make someone else an owner first.",
  [ROLE_NOT_OFFERED]: "This invitation's role can no longer be given. Cancel it and invite again.",
  [WORKSPACE_CHANGED]:
    "This session switched to another workspace in a different tab. Reload this page before inviting.",
  [INVITATION_RATE_LIMITED]: "You have sent a lot of invitations in the last hour. Try again later.",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "This person is already a member of this workspace.",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION:
    "This address already has a pending invitation. Resend it from the list below.",
  INVITATION_LIMIT_REACHED: "This workspace has too many pending invitations. Cancel some first.",
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: "This workspace cannot take more members.",
  MEMBER_NOT_FOUND: MEMBER_GONE,
  INVITATION_NOT_FOUND: INVITATION_GONE,
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: ASK_TO_MANAGE_MEMBERS,
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: ASK_TO_MANAGE_MEMBERS,
  YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: ASK_TO_MANAGE_MEMBERS,
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: ASK_TO_MANAGE_MEMBERS,
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: ASK_TO_MANAGE_MEMBERS,
};
