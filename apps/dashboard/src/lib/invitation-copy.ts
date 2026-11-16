/**
 * What the invitation screen may say about a failure. Allowlisted by Better
 * Auth error code (`organizations.ts` maps a thrown error to one of these);
 * the provider's own text never reaches the page.
 */
export const INVITATION_RETRY = "Something went wrong with this invitation. Please try again.";

export const INVITATION_BAD_LINK = "This link is incomplete. Open it again from your invitation email.";

// One sentence for "not found", "expired" and "sent to someone else": telling
// them apart would confirm an invitation id to an account it was not sent to.
export const INVITATION_UNAVAILABLE =
  "This invitation is not available to the account you are signed in with. It may have expired or been sent to a different email address.";
// Only reachable by the invited identity, so it says nothing to anyone else.
const NO_LONGER_VALID = "This invitation is no longer valid. Ask for a new one.";
const UNVERIFIED = "Verify your email address, then open the invitation link again.";

export const INVITATION_COPY: Record<string, string> = {
  UNAUTHORIZED: "Your session has expired. Sign in again to accept the invitation.",
  INVITATION_NOT_FOUND: INVITATION_UNAVAILABLE,
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: INVITATION_UNAVAILABLE,
  ORGANIZATION_NOT_FOUND: NO_LONGER_VALID,
  INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION: NO_LONGER_VALID,
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: UNVERIFIED,
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION: UNVERIFIED,
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED:
    "This workspace cannot take more members right now. Tell whoever invited you.",
};
