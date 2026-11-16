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
  button: "Connect with Meta",
  preparing: "Preparing…",
  connecting: "Connecting…",
  connectedTitle: "Connected.",
  connected: (phone: string | null, workspace: string) =>
    `${phone ?? "Your number"} now works with ${workspace}. Nothing changes on your phone. You can close this page.`,
  pending: (inviter: string) =>
    `Your WhatsApp account is connected, but the number is not ready yet. ${inviter} will finish it. You can close this page.`,
  unknown: (inviter: string) =>
    `We are checking whether your number was connected. ${inviter} will confirm it. Do not start again.`,
  busy: "A connection with this link is already in progress. Wait a minute, then start again.",
  notPrepared: "The connection could not be prepared. Close Meta's window and start again.",
  cancelled: "Nothing was connected. You can start again with the same link.",
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
