import type { SignupErrorCode } from "../connect-result";

const PAGE_LINKED =
  "This number is linked to a Facebook Page. In Meta Business Suite, open Settings, Accounts, Pages and remove that Page from the portfolio, then start again with the same link.";
const NOT_FROM_APP = "Meta cannot connect this number from the WhatsApp Business app. Tell whoever sent you this link.";

/** What an error reported in Meta's window means, and what to do. */
const signupErrors: Record<SignupErrorCode, string> = {
  "3441067":
    "This number is on a WhatsApp Business account in a business portfolio you do not manage, often one set up by another WhatsApp provider. Ask that provider or the portfolio's admin to release the number, then start again with the same link.",
  "3441069":
    "This number is on the regular WhatsApp app, not the WhatsApp Business app. Move it to the WhatsApp Business app, then start again with the same link.",
  "3441070": NOT_FROM_APP,
  "3441072": NOT_FROM_APP,
  "3441090":
    "This number is on another WhatsApp Business account in your own business portfolio. Remove it from that account in WhatsApp Manager, then start again with the same link.",
  "3441071":
    "The business portfolio that owns this number requires two-factor authentication on your Facebook account. Turn it on in Facebook's security settings, then start again with the same link.",
  "3441075": "This number has two-step verification turned on. Turn it off, then start again with the same link.",
  "2655145":
    "Your Facebook account is restricted from managing business assets. Review the restriction in Meta's Business Support Home, or ask someone else in your business to open this link.",
  "2655123": PAGE_LINKED,
  "2655082": PAGE_LINKED,
  "3441093":
    "This number is still being disconnected from a previous connection, which can take from a few minutes to more than a day. Start again with the same link later.",
  "2494064":
    "This number is already registered with another WhatsApp service, such as another WhatsApp API provider. Ask them to release it, then start again with the same link.",
};

/** The connection-link landing page, in English. `es.ts` must carry the same keys. */
export const en = {
  lang: "en",
  pageTitle: "Connect your WhatsApp number",
  /** What a link preview shows. */
  summary: "Connect the number your business uses in the WhatsApp Business app. It takes about 5 minutes.",
  loading: "Checking the link…",
  title: (workspace: string) => `Connect your WhatsApp number to ${workspace}`,
  intro: (inviter: string) =>
    `${inviter} asked you to connect the number your business uses in the WhatsApp Business app. You keep using the app on your phone as usual.`,
  beforeTitle: "Before you start",
  before: ["This computer and the phone, both at hand", "A Facebook account (your own is fine)", "About 5 minutes"],
  meta: "Meta will open a window, ask you to sign in, and show a QR code to scan from the phone. Your number and your Meta business account stay yours.",
  release:
    "Used this number with another WhatsApp API provider or business portfolio? Ask them to release it first.",
  button: "Connect with Meta",
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
  /** Meta's references for a reported error, for whoever helps. */
  reported: (code?: string, session?: string) => {
    const refs = [code && `error ${code}`, session && `session ${session}`].filter(Boolean);
    return `Meta reported ${refs.join(", ")}. Share ${refs.length > 1 ? "both" : "it"} if you ask for help.`;
  },
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
