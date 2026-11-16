import { deriveIdempotencyKey, type MailSender } from "../auth/mail";
import type { LinkOutcome } from "../lib/connect-link/api";

type Reported = Exclude<LinkOutcome["outcome"], "gone" | "state" | "busy">;

/** What the admin reads; the bearer's page has its own wording. */
const REASONS: Record<Exclude<Reported, "connected">, string> = {
  unknown: "The connection broke off before its result was known. Open Numbers to see whether the number is there.",
  pending: "Meta connected the account, but the number is not ready. Open Numbers to see what it needs.",
  denied: "Meta ended the connection before a number was attached.",
  owned: "That WhatsApp Business Account is already connected to another Eccos workspace.",
  no_waba: "The Meta login shared no WhatsApp Business Account.",
  subscription_required: "This workspace cannot add new numbers.",
  failed: "The connection could not be completed.",
};

/** Tells the link's creator how it went. Best effort: mail never fails a connection. */
export async function mailLinkOutcome(
  mail: MailSender,
  message: { to: string; workspace: string; url: string; outcome: Reported; unique: string },
): Promise<void> {
  const { to, workspace, url, outcome } = message;
  const template = outcome === "connected" ? "connect-link-connected" : "connect-link-failed";
  try {
    await mail.sendTemplate({
      template,
      to,
      variables: outcome === "connected" ? { workspace, url } : { workspace, url, reason: REASONS[outcome] },
      idempotencyKey: await deriveIdempotencyKey(template, to, message.unique),
    });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", area: "connect-link", event: "mail-failed", template, error: err instanceof Error ? err.name : "unknown" }),
    );
  }
}
