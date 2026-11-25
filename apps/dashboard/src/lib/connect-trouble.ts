import type { Feedback } from "../components/dashboard/use-embedded-signup";
import { QR_CODE_STEP } from "./connect-result";
import type { ConnectPath } from "./embedded-signup";

/** Which troubleshooting screen an attempt's feedback opens. */
export type Trouble = "provider" | "regular-app" | "pin" | "meta" | "popup" | "closed" | "error";

/** Null while nothing went wrong, or while the window may just be behind this one. */
export function troubleFor(feedback: Feedback | null): Trouble | null {
  if (!feedback) return null;
  if (feedback.tone === "meta") {
    if (feedback.code === "3441067") return "provider";
    if (feedback.code === "3441069") return "regular-app";
    if (feedback.code === "3441075") return "pin";
    return "meta";
  }
  if (feedback.tone === "blocked") return "popup";
  if (feedback.tone === "notice") return "closed";
  if (feedback.tone === "error") return "error";
  return null;
}

/** Where Meta's window was closed, when the console knows the screen. */
export function closedAt(feedback: Feedback | null): string | null {
  return feedback?.tone === "notice" && feedback.step === QR_CODE_STEP ? "Closed at the QR code screen" : null;
}

export const FOUNDER_EMAIL = "santi@eccos.chat";

const PATH_NAMES: Record<ConnectPath, string> = {
  "business-app": "WhatsApp Business app",
  "new-number": "New number",
};

/** The technical part added under the customer's own words, from what the wizard knows. */
export function helpContext({
  path,
  stage,
  feedback,
}: {
  path: ConnectPath | null;
  stage: string;
  feedback: Feedback | null;
}): string[] {
  const lines = [`Path: ${path ? PATH_NAMES[path] : "not chosen yet"}`, `Stopped at: ${stage}`];
  const closed = closedAt(feedback);
  if (closed) lines.push(closed);
  if (feedback?.tone === "meta") lines.push(feedback.error.refs);
  else if (feedback?.tone === "error" || feedback?.tone === "blocked") lines.push(feedback.text);
  return lines;
}

/** A mailto link to the founder carrying the message and its context. */
export function helpMailto(message: string, context: string[]): string {
  const body = [message.trim(), "", ...context].join("\n").trim();
  return `mailto:${FOUNDER_EMAIL}?subject=${encodeURIComponent("Help connecting WhatsApp")}&body=${encodeURIComponent(body)}`;
}

/** What a customer can send the provider that still holds their number (3441067). */
export const RELEASE_REQUEST =
  "Hello. We are moving our WhatsApp number to another provider. Please release it from your WhatsApp Business account, so we can connect it there. Meta reports it is still held by your business portfolio (error 3441067). Thank you.";
