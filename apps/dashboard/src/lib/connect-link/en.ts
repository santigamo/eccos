import type { SignupErrorCode, SignupErrorCopy } from "../connect-result";

const PAGE_LINKED: SignupErrorCopy = {
  title: "A Facebook Page is linked to this number",
  body: "In Meta Business Suite, remove the Page under Settings, Accounts, Pages, then come back to this same link.",
};
const NOT_FROM_APP: SignupErrorCopy = {
  title: "Meta can't connect this number from the app",
  body: "Tell whoever sent you this link.",
};

/** What an error reported in Meta's window means, and what to do. */
const signupErrors: Record<SignupErrorCode, SignupErrorCopy> = {
  "3441067": {
    title: "Another business portfolio holds this number",
    body: "Usually your previous WhatsApp provider. Ask them to release the number, then come back to this same link.",
  },
  "3441069": {
    title: "This number is on the regular WhatsApp app",
    body: "Move it to the WhatsApp Business app, then come back to this same link.",
  },
  "3441070": NOT_FROM_APP,
  "3441072": NOT_FROM_APP,
  "3441090": {
    title: "Another account in your portfolio holds this number",
    body: "Remove it from that account in WhatsApp Manager, then come back to this same link.",
  },
  "3441071": {
    title: "Your Facebook account needs two-factor authentication",
    body: "The portfolio that owns this number requires it. Turn it on in Facebook's security settings, then come back to this same link.",
  },
  "3441075": {
    title: "Two-step verification is on for this number",
    body: "Turn it off, then come back to this same link.",
  },
  "2655145": {
    title: "Your Facebook account can't manage business assets",
    body: "Review the restriction in Meta's Business Support Home, or ask someone else in your business to open this link.",
  },
  "2655123": PAGE_LINKED,
  "2655082": PAGE_LINKED,
  "3441093": {
    title: "This number is still being disconnected",
    body: "That can take from a few minutes to more than a day. Come back to this same link later.",
  },
  "2494064": {
    title: "This number is registered with another WhatsApp service",
    body: "Usually another WhatsApp provider. Ask them to release it, then come back to this same link.",
  },
};

/** The connection-link landing page, in English. `es.ts` must carry the same keys. */
export const en = {
  lang: "en",
  pageTitle: "Connect your WhatsApp number",
  /** What a link preview shows. */
  summary: "Connect the number your business uses in the WhatsApp Business app. It takes about 5 minutes.",
  loading: "Checking the link…",
  /** Read as: inviter, [0], workspace, [1]. */
  intro: [" asks you to connect your WhatsApp Business app number to ", ". The app keeps working as usual."] as [
    string,
    string,
  ],
  beforeTitle: "You need",
  before: ["This computer and the phone at hand, to scan a QR code", "A Facebook account (your own is fine)"],
  release: {
    lead: "Used this number with another WhatsApp provider?",
    rest: "Ask them to release it first.",
  },
  button: "Connect with Meta",
  ownership: "Your number and your Meta account stay yours.",
  preparing: "Preparing…",
  connecting: "Connecting…",
  connectedTitle: "Connected.",
  connected: (phone: string | null, workspace: string) =>
    `${phone ?? "Your number"} now works with ${workspace}. Nothing changes on your phone. You can close this page.`,
  leftOut: (inviter: string) => `Some numbers were left out: this workspace cannot add new numbers right now. Tell ${inviter}.`,
  pending: (inviter: string) =>
    `Your WhatsApp account is connected, but the number is not ready yet. ${inviter} will finish it. You can close this page.`,
  unknown: (inviter: string) =>
    `We are checking whether your number was connected. ${inviter} will confirm it. Do not start again.`,
  busy: "A connection with this link is already in progress. Wait a minute, then start again.",
  notPrepared: "The connection could not be prepared. Close Meta's window and start again.",
  cancelled: "Nothing was connected. You can start again with the same link.",
  signupErrors,
  unknownError: "Meta didn't connect the number",
  notConnected: "Not connected",
  /** Meta's references for a reported error, for whoever helps. */
  reported: (code: string, session?: string) => (session ? `Meta error ${code} · session ${session}` : `Meta error ${code}`),
  copyLabels: { copy: "Copy", copied: "Copied", failed: "Copy failed" },
  gone: (inviter: string) => `This link no longer works. Ask ${inviter} for a new one.`,
  sender: "whoever sent it to you",
  owned: (inviter: string) => `This number's Meta account is already connected elsewhere. Tell ${inviter}.`,
  noWaba: "Meta did not share a WhatsApp account. Start again and finish every step in Meta's window.",
  closed: (inviter: string) => `This workspace cannot add numbers right now. Tell ${inviter}.`,
  failed: "The connection could not be completed. Start again with the same link.",
  attemptExpired: "That attempt took too long. Start again with the same link.",
  popupBlocked: (host: string) => `Your browser blocked Meta's window. Allow pop-ups for ${host}, then click again.`,
  closeMeta: "Close Meta's window and try again.",
  scriptBlocked: "Meta's script did not load. Turn off any blocker for this page and reload it.",
  unavailable: (inviter: string) => `Connecting is not available right now. Tell ${inviter}.`,
  limited: "Too many attempts. Wait a few minutes, then open the link again.",
  unreachable: "Could not reach Eccos. Check your connection and reload the page.",
};

export type ConnectLinkCopy = typeof en;
