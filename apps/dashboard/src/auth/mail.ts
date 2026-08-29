/**
 * Application-owned email delivery interface for the identity plane.
 *
 * Better Auth needs to send verification, password-reset, and (later) invitation
 * emails. Per the tenancy contract (docs/auth-tenancy-contract.md §8), the
 * provider lives behind this small server-side adapter: provider credentials are
 * Worker secrets and never reach the client or logs, and message URLs (which
 * carry action-capable tokens) are never logged.
 *
 * This bead ships the interface plus a development sender. The production
 * provider configuration (SPF/DKIM, retries, bounces, monitoring) is owned by
 * eccos-0x0.11.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailSender {
  sendMail(message: MailMessage): Promise<void>;
}

/**
 * Development sender. Records nothing sensitive: only the recipient's domain
 * and the subject are logged. Reset/verification URLs carry action-capable
 * tokens and are NEVER logged.
 */
export class ConsoleMailSender implements MailSender {
  async sendMail(message: MailMessage): Promise<void> {
    const domain = message.to.split("@")[1] ?? "unknown";
    console.info(
      JSON.stringify({
        level: "info",
        area: "auth-mail",
        event: "email-dev-send",
        toDomain: domain,
        subject: message.subject,
      }),
    );
  }
}

/**
 * Test helper: captures every sent message so tests can assert on the
 * verification / reset emails Better Auth produces.
 */
export class CaptureMailSender implements MailSender {
  readonly sent: MailMessage[] = [];

  async sendMail(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Env shape the mail adapter reads (all optional in development). */
export interface MailEnv {
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
}

/**
 * Build the mail sender for the current environment. In this bead only the
 * development sender exists; configuring a real provider (and failing closed on
 * missing provider secrets in production) is eccos-0x0.11.
 */
export function createMailSender(_env: MailEnv): MailSender {
  // TODO(eccos-0x0.11): select and configure the production provider behind
  // this interface; keep provider secrets in Worker secrets/bindings only.
  return new ConsoleMailSender();
}
