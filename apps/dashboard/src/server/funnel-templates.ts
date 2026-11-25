/**
 * The funnel templates, as synced to the provider (docs/auth-email-delivery.md,
 * "Funnel emails"). Copy from Paper "4 · Emails". The recovery email is a plain
 * personal note; the others use the console's transactional shell.
 */
import type { MailTemplate } from "../auth/mail";

export interface ProviderTemplate {
  id: Extract<MailTemplate, `funnel-${string}`>;
  subject: string;
  body_text: string;
  body_html: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const P = `font-family:${FONT};font-size:15px;line-height:1.6;color:#3d4744;`;

const paragraph = (html: string, top = 16) => `<tr><td style="padding:${top}px 32px 0;${P}">${html}</td></tr>`;

const button = (label: string) => `<tr><td style="padding:24px 32px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="#25d366" style="background-color:#25d366;padding:14px 28px;">
<a href="{{url}}" style="font-family:${FONT};font-size:15px;font-weight:600;color:#06120c;text-decoration:none;display:inline-block;">${label}</a>
</td></tr></table>
</td></tr>`;

const list = (title: string, items: string[]) =>
  `<tr><td style="padding:16px 32px 0;font-family:${FONT};">
<div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7772;padding-bottom:4px;">${title}</div>
${items.map((item) => `<div style="${P}">&middot;&nbsp; ${item}</div>`).join("\n")}
</td></tr>`;

function shell(subject: string, preheader: string, rows: string[], founderTitle: boolean): string {
  const signoff = `<tr><td style="padding:24px 32px 30px;font-family:${FONT};font-size:15px;line-height:1.5;color:#0b141a;">Santi${
    founderTitle ? `<br><span style="font-size:13px;color:#6b7772;">Founder, Eccos</span>` : ""
  }</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f4;-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;color:#f5f5f4;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f4;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e2e2dd;">
<tr><td style="padding:0;font-size:0;line-height:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="34%" height="4" bgcolor="#25d366" style="background-color:#25d366;font-size:0;line-height:0;height:4px;">&nbsp;</td>
<td width="33%" height="4" bgcolor="#34e27a" style="background-color:#34e27a;font-size:0;line-height:0;height:4px;">&nbsp;</td>
<td width="33%" height="4" bgcolor="#0fb39a" style="background-color:#0fb39a;font-size:0;line-height:0;height:4px;">&nbsp;</td>
</tr></table>
</td></tr>
<tr><td style="padding:30px 32px 0;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:0.22em;color:#0b141a;">ECCOS</td></tr>
${rows.join("\n")}
${signoff}
</table>
</td></tr></table>
</body>
</html>
`;
}

/** A personal note: no brand, no button, the link inline. */
function plain(subject: string, paragraphs: string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:24px 16px;background-color:#ffffff;">
<div style="max-width:560px;${P}color:#1f2725;">
${paragraphs.map((html) => `<p style="margin:0 0 16px;">${html}</p>`).join("\n")}
<p style="margin:0;">Santi</p>
</div>
</body>
</html>
`;
}

const strong = (value: string) => `<strong style="color:#0b141a;font-weight:600;">${value}</strong>`;

const RECOVERY_SUBJECT = "Hit a snag connecting your number?";
const ACTIVATED_SUBJECT = "Your WhatsApp number is working";
const WINDOW_SUBJECT = "24 hours left to keep your number running";
const PAUSED_SUBJECT = "Your number is paused. Nothing is lost.";
const NEVER_SUBJECT = "Your number pauses in 2 days. Can I help?";

export const FUNNEL_TEMPLATES: ProviderTemplate[] = [
  {
    id: "funnel-recovery",
    subject: RECOVERY_SUBJECT,
    body_text: `Hi {{name}},

I'm Santi, I built Eccos. Thanks for giving it a try 😄

{{situation}} You can pick up where you left off whenever you want: {{url}}

Hit a snag? Reply to this email and I'll help you myself. And if Eccos was not what you were looking for, it helps me to know that too.

Santi
`,
    body_html: plain(RECOVERY_SUBJECT, [
      "Hi {{name}},",
      "I'm Santi, I built Eccos. Thanks for giving it a try 😄",
      `{{situation}} You can <a href="{{url}}" style="color:#0b141a;text-decoration:underline;">pick up where you left off</a> whenever you want.`,
      "Hit a snag? Reply to this email and I'll help you myself. And if Eccos was not what you were looking for, it helps me to know that too.",
    ]),
  },
  {
    id: "funnel-activated",
    subject: ACTIVATED_SUBJECT,
    body_text: `Hi {{name}},

{{first_message}} Your number {{phone}} is set up and working.

You have 72 hours to keep setting things up, until {{window_ends}}.

To keep it running after that, the subscription is 5 € per month for this number, plus VAT. Eccos never charges per message.

Start subscription: {{url}}

If you do not subscribe, nothing is deleted. Sending stops, and new messages are not passed on to your tool until you do.

Any question, reply to this email.

Santi
Founder, Eccos
`,
    body_html: shell(
      ACTIVATED_SUBJECT,
      "Your number is set up and working.",
      [
        paragraph("Hi {{name}},", 22),
        paragraph(`{{first_message}} Your number ${strong("{{phone}}")} is set up and working.`),
        paragraph(`You have 72 hours to keep setting things up, until ${strong("{{window_ends}}")}.`),
        paragraph("To keep it running after that, the subscription is 5 € per month for this number, plus VAT. Eccos never charges per message."),
        button("Start subscription"),
        paragraph("If you do not subscribe, nothing is deleted. Sending stops, and new messages are not passed on to your tool until you do."),
        paragraph("Any question, reply to this email."),
      ],
      true,
    ),
  },
  {
    id: "funnel-window-ending",
    subject: WINDOW_SUBJECT,
    body_text: `Hi {{name}},

Your setup window ends tomorrow, {{window_ends}}. From then, Eccos stops sending and stops passing new messages on to your tool.

New messages are still saved, you can still read them in Eccos, and your number stays registered with Meta.

To keep everything running, the subscription is 5 € per month, plus VAT.

Start subscription: {{url}}

If something is stopping you, reply and tell me.

Santi
Founder, Eccos
`,
    body_html: shell(
      WINDOW_SUBJECT,
      "Your setup window ends tomorrow.",
      [
        paragraph("Hi {{name}},", 22),
        paragraph(
          `Your setup window ends tomorrow, ${strong("{{window_ends}}")}. From then, Eccos stops sending and stops passing new messages on to your tool.`,
        ),
        paragraph("New messages are still saved, you can still read them in Eccos, and your number stays registered with Meta."),
        paragraph("To keep everything running, the subscription is 5 € per month, plus VAT."),
        button("Start subscription"),
        paragraph("If something is stopping you, reply and tell me."),
      ],
      true,
    ),
  },
  {
    id: "funnel-paused",
    subject: PAUSED_SUBJECT,
    body_text: `Hi {{name}},

{{opening}}

What stopped
- Sending messages through Eccos.
- Passing new messages on to your tool.

What still works
- Every new message is saved.
- You can read everything in Eccos.
- Your number stays registered with Meta.

When you subscribe (5 € per month, plus VAT), everything goes live again.

Start subscription: {{url}}

After that, you choose whether to send the saved messages to your tool. Eccos never sends them on its own.

Any question, reply to this email.

Santi
Founder, Eccos
`,
    body_html: shell(
      PAUSED_SUBJECT,
      "Messages are still saved. Subscribe to resume.",
      [
        paragraph("Hi {{name}},", 22),
        paragraph("{{opening}}"),
        list("What stopped", ["Sending messages through Eccos.", "Passing new messages on to your tool."]),
        list("What still works", [
          "Every new message is saved.",
          "You can read everything in Eccos.",
          "Your number stays registered with Meta.",
        ]),
        paragraph("When you subscribe (5 € per month, plus VAT), everything goes live again."),
        button("Start subscription"),
        paragraph("After that, you choose whether to send the saved messages to your tool. Eccos never sends them on its own."),
        paragraph("Any question, reply to this email."),
      ],
      true,
    ),
  },
  {
    id: "funnel-never-activated",
    subject: NEVER_SUBJECT,
    body_text: `Hi {{name}},

You connected {{phone}} on {{connected_on}}, but no message has gone through Eccos yet. Usually one small step is missing.

On {{pauses_on}} the number will be paused. Until then you can finish the setup. It takes a few minutes.

Finish the setup: {{url}}

Or reply and tell me what you wanted to do with it. I'll point you to the right step.

Santi
`,
    body_html: shell(
      NEVER_SUBJECT,
      "Usually one small step is missing.",
      [
        paragraph("Hi {{name}},", 22),
        paragraph(
          `You connected ${strong("{{phone}}")} on {{connected_on}}, but no message has gone through Eccos yet. Usually one small step is missing.`,
        ),
        paragraph(`On ${strong("{{pauses_on}}")} the number will be paused. Until then you can finish the setup. It takes a few minutes.`),
        button("Finish the setup"),
        paragraph("Or reply and tell me what you wanted to do with it. I'll point you to the right step."),
      ],
      false,
    ),
  },
];
