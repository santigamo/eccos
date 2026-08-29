/**
 * Resend-backed `MailSender` — the production email provider adapter
 * (eccos-0x0.11). Chosen for first-party Workers support (REST API over fetch,
 * no Node-only dependencies in the send path) and EU region selection on the
 * sending domain.
 *
 * Security/privacy invariants (contract §8):
 * - the API key lives only in Worker secrets (`RESEND_API_KEY`), never in the
 *   repo, the client, or logs;
 * - action-capable URLs (verification / reset / invitation links) are never
 *   logged — only the recipient domain and subject are;
 * - delivery failures surface as thrown errors so Better Auth's flow fails
 *   closed instead of silently dropping the message.
 */

import { Resend } from "resend";
import type { MailMessage, MailSender } from "./mail";

/** Env bindings/secrets the adapter reads. */
export interface ResendMailEnv {
  RESEND_API_KEY?: string;
  /** Verified sending identity, e.g. "Eccos <noreply@notify.eccos.chat>". */
  MAIL_FROM?: string;
}

/** Default sender used in development when MAIL_FROM is unset. */
const DEV_FROM = "Eccos Dev <onboarding@resend.dev>";

export class ResendMailSender implements MailSender {
  private readonly client: Resend;
  private readonly from: string;

  constructor(env: ResendMailEnv) {
    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      // Fail closed: a configured-but-unkeyed deployment must not boot.
      throw new Error("RESEND_API_KEY must be configured for the mail adapter");
    }
    this.client = new Resend(apiKey);
    this.from = env.MAIL_FROM?.trim() || DEV_FROM;
  }

  async sendMail(message: MailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    if (error) {
      // Provider rejection (invalid address, domain unverified, rate limit…).
      // Thrown so the auth flow fails closed; no tokens are included in the
      // error (Resend errors carry ids/messages, not URLs).
      throw new Error(`mail delivery failed: ${error.name} ${error.message}`);
    }
  }
}
