/**
 * The funnel emails the gateway asks the console to send (eccos-dbb3.4).
 *
 * The gateway owns the timers and the activation signal (eccos-dbb3.2); the
 * console owns the recipients, the copy and the dedupe. The gateway calls
 * `FUNNEL_MAIL.sendFunnelEmail(input)` over a service binding to the
 * dashboard Worker's `FunnelMailRPC` entrypoint. Every call is idempotent per
 * account and kind, so a retried alarm never mails twice. Times are Unix ms.
 */
export type FunnelMailInput =
  | {
      /** Right after activation: the first 2xx webhook delivery or the first outbound delivered. */
      kind: "activated";
      organizationId: string;
      accountId: string;
      activatedAt: number;
      /** `webhook`: a message reached the subscriber. `outbound`: a sent message was delivered. */
      via: "webhook" | "outbound";
      windowEndsAt: number;
    }
  | {
      /** 48 h after activation, 24 h before the window ends. Skipped once the account has subscribed. */
      kind: "window_ending";
      organizationId: string;
      accountId: string;
      windowEndsAt: number;
    }
  | {
      /** When the account is paused: the window ended, or day 14 without activation. */
      kind: "paused";
      organizationId: string;
      accountId: string;
      pausedAt: number;
      reason: "window_ended" | "never_activated";
    }
  | {
      /** Day 12 after the first number connected, never activated. Skipped once the account has subscribed. */
      kind: "never_activated_warning";
      organizationId: string;
      accountId: string;
      connectedAt: number;
      pausesAt: number;
    };

export type FunnelMailKind = FunnelMailInput["kind"];

export type FunnelMailResult =
  | { status: "sent"; recipients: number }
  /** Already sent for this account and kind. */
  | { status: "duplicate" }
  | { status: "skipped"; reason: "not_linked" | "subscribed" | "no_recipients" };

export interface FunnelMailApi {
  sendFunnelEmail(input: FunnelMailInput): Promise<FunnelMailResult>;
}
