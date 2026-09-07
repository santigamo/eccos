import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboundRow, OutboundRow } from "../src/server/gateway";

/**
 * The two inspection sheets (`components/logs/*-sheet.tsx`).
 *
 * WHAT IS RENDERED HERE AND WHY. A closed Base UI dialog renders nothing at
 * all, so `renderToStaticMarkup(<MessageSheet open …>)` would assert against an
 * empty string. The sheets therefore export their inner block — the same split
 * `TemplatePreview` uses — and these tests render that. What a static frame
 * genuinely cannot reach is the OPEN/CLOSE behaviour itself (the portal, the
 * Escape handler, the backdrop): those belong to Base UI and are exercised
 * where the overlay contract is, not here.
 *
 * The event sheet renders a router `Link`, so the router is stubbed the way
 * `nav-setup.test.tsx` stubs it.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

// SPREAD, not replaced: `mock.module` swaps the module process-wide and the
// first stub fixes which keys exist.
const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}));

const { MessageDetail } = await import("../src/components/logs/message-sheet");
const { EventDetail } = await import("../src/components/logs/event-sheet");
const { HeldNotice } = await import("../src/components/logs/held-notice");

const WAMID = "wamid.HBgLMzQ2MDAwMDAwMDAVAgARGBI5QUY";

const message: OutboundRow = {
  id: 1042,
  transport_message_id: WAMID,
  recipient: "34600000000",
  phone_number_id: "PNID1",
  request: JSON.stringify({
    to: "34600000000",
    type: "template",
    template: { name: "cita_encontrada", language: { code: "es" } },
  }),
  status: "sent",
  error: null,
  created_at: 1_700_000_000_000,
  trail: [
    { type: "delivered", at: 1_700_000_001_000, errorCode: null, deliveryStatus: "delivered", deliveryAttempts: 1 },
    { type: "read", at: 1_700_000_002_000, errorCode: null, deliveryStatus: "pending", deliveryAttempts: 0 },
  ],
};

describe("MessageDetail", () => {
  test("the full wamid lives here, where there is room for it", () => {
    // The log no longer prints sixty characters of base64 on every row — this
    // is the one place it appears whole, because it is what a developer pastes
    // into a Meta support case.
    const html = renderToStaticMarkup(
      <MessageDetail row={message} hasForwardingTarget={true} />,
    );
    expect(html).toContain(WAMID);
    expect(html).toContain("Meta message id");
  });

  test("the trail says Meta's words and the forward hop says its own", () => {
    const html = renderToStaticMarkup(
      <MessageDetail row={message} hasForwardingTarget={true} />,
    );
    // Meta → phone.
    expect(html).toContain(">delivered<");
    expect(html).toContain(">read<");
    // Eccos → subscriber, for the batch that carried each. The word
    // `forwarded` exists precisely so this cannot read as the line above it.
    expect(html).toContain(">forwarded<");
    expect(html).toContain(">queued<");
  });

  test("a refused send explains why it has no trail, instead of showing a gap", () => {
    // Two different silences: no wamid means no callback can ever be about it,
    // which is not the same as "nothing back yet".
    const failed: OutboundRow = {
      ...message,
      status: "failed",
      transport_message_id: null,
      error: '{"code":131047}',
      trail: [],
    };
    const html = renderToStaticMarkup(<MessageDetail row={failed} hasForwardingTarget={true} />);
    expect(html).toContain("no message id");
    expect(html).toContain("131047");
  });

  test("a template send reads as its VALUES, labelled by slot", () => {
    // The readable answer to "what did this message say" that the sheet used
    // to give as pretty-printed JSON and nothing else.
    const filled: OutboundRow = {
      ...message,
      request: JSON.stringify({
        to: "34600000000",
        type: "template",
        template: {
          name: "cita_encontrada",
          language: { code: "es" },
          components: [
            {
              type: "header",
              parameters: [{ type: "image", image: { link: "https://cdn.example/a.png" } }],
            },
            { type: "body", parameters: [{ type: "text", text: "Ada" }] },
          ],
        },
      }),
    };
    const html = renderToStaticMarkup(<MessageDetail row={filled} hasForwardingTarget={true} />);
    expect(html).toContain("What was sent");
    expect(html).toContain("{{1}}");
    expect(html).toContain("Ada");
    expect(html).toContain("image · https://cdn.example/a.png");
  });

  test("the template is a LINK, and the link says it is today's copy", () => {
    // The one thing this sheet must never do is pour these values into the
    // template as it stands now: a template edited since would render a
    // message that was never sent, with the authority of a preview.
    const html = renderToStaticMarkup(
      <MessageDetail row={message} hasForwardingTarget={true} wabaId="WABA1" />,
    );
    expect(html).toContain('href="/templates"');
    expect(html).toContain("as it stands now");
  });

  test("a free-form text send shows the message itself", () => {
    const text: OutboundRow = {
      ...message,
      request: JSON.stringify({ to: "34600000000", type: "text", text: { body: "on my way" } }),
    };
    const html = renderToStaticMarkup(<MessageDetail row={text} hasForwardingTarget={true} />);
    expect(html).toContain("on my way");
    // Nothing to link to: there is no template behind a free-form send.
    expect(html).not.toContain('href="/templates"');
  });

  test("the Meta body is KEPT, behind a disclosure rather than as the section", () => {
    // Deleting it would push a 132000 argument out of the product and into
    // Cloudflare logs. It is still in the markup, and it is no longer the
    // first thing an operator meets.
    const html = renderToStaticMarkup(
      <MessageDetail row={message} hasForwardingTarget={true} />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("Request body, exactly as sent to Meta");
    expect(html).toContain("&quot;name&quot;: &quot;cita_encontrada&quot;");
  });

  test("a swept body says so, and offers no disclosure over nothing", () => {
    const swept: OutboundRow = { ...message, request: "" };
    const html = renderToStaticMarkup(<MessageDetail row={swept} hasForwardingTarget={true} />);
    expect(html).toContain("past its retention window");
    expect(html).not.toContain("<details");
  });
});

const statusEvent: InboundRow = {
  id: 77,
  type: "delivered",
  transport_message_id: WAMID,
  message_id: null,
  phone_number_id: "PNID1",
  payload: JSON.stringify({ type: "delivered", transportMessageId: WAMID, at: 1_700_000_001_000 }),
  received_at: 1_700_000_001_500,
  delivery_id: 5,
  delivery_status: "pending",
  delivery_attempts: 0,
  delivery_created_at: 1_700_000_001_500,
  delivery_finished_at: null,
  delivery_next_attempt_at: 1_700_000_001_500,
  delivery_last_error: null,
  delivery_event_count: 3,
  outbound_id: 1042,
  outbound_request: message.request,
};

describe("EventDetail", () => {
  test("the event JSON is KEPT VERBATIM, behind a disclosure", () => {
    // What the receiver got, byte for byte. Every "my handler never saw it"
    // argument ends here rather than at a summary the console composed — which
    // is exactly why the disclosure's summary makes that claim, and why the
    // payload moved rather than went away.
    const html = renderToStaticMarkup(
      <EventDetail row={statusEvent} hasForwardingTarget={true} />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("Event JSON, exactly what your receiver got");
    expect(html).toContain("&quot;transportMessageId&quot;: &quot;wamid.");
    expect(html).toContain("2 other events");
  });

  test("a delivery receipt says it carries no content, rather than showing a gap", () => {
    const html = renderToStaticMarkup(
      <EventDetail row={statusEvent} hasForwardingTarget={true} />,
    );
    expect(html).toContain("What arrived");
    expect(html).toContain("A delivered event carries no text");
  });

  test("Meta's own moment and Eccos' are both named, never merged", () => {
    // They differ by the callback's flight time; the first is what an operator
    // compares against a customer's screenshot, and it was legible only inside
    // the raw JSON before this.
    const html = renderToStaticMarkup(
      <EventDetail row={statusEvent} hasForwardingTarget={true} />,
    );
    expect(html).toContain("Happened at");
    expect(html).toContain(">Received<");
  });

  test("a failure names the Graph code and Meta's sentence, each under its own label", () => {
    const failure: InboundRow = {
      ...statusEvent,
      id: 79,
      type: "failed",
      payload: JSON.stringify({
        type: "failed",
        transportMessageId: WAMID,
        errorCode: "131047",
        errorMessage: "Re-engagement message",
        at: 1_700_000_001_000,
      }),
    };
    const html = renderToStaticMarkup(<EventDetail row={failure} hasForwardingTarget={true} />);
    expect(html).toContain("Error code");
    expect(html).toContain("131047");
    // Meta's words, attributed to Meta — the console diagnoses nothing here.
    expect(html).toContain("Meta says");
    expect(html).toContain("Re-engagement message");
  });

  test("a held batch says held, with no invented next time", () => {
    const html = renderToStaticMarkup(
      <EventDetail row={statusEvent} hasForwardingTarget={false} />,
    );
    expect(html).toContain(">held<");
    expect(html).toContain("Held since");
    expect(html).toContain("0 of 6");
  });

  test("a status event carries the door to the message it is about", () => {
    // Data rule 2 across logs: the wamid used to be printed in full on both
    // pages and was a door on neither.
    const html = renderToStaticMarkup(
      <EventDetail row={statusEvent} hasForwardingTarget={true} wabaId="WABA1" />,
    );
    expect(html).toContain('href="/messages"');
    expect(html).toContain("#1042 cita_encontrada");
  });

  test("an unmatched wamid says so, rather than pointing nowhere", () => {
    const orphan: InboundRow = { ...statusEvent, outbound_id: null, outbound_request: null };
    const html = renderToStaticMarkup(<EventDetail row={orphan} hasForwardingTarget={true} />);
    expect(html).not.toContain('href="/messages"');
    expect(html).toContain("…VAgARGBI5QUY");
    expect(html).toContain("outside Eccos");
  });

  test("Retry appears only when the batch failed", () => {
    // Data rule 5, and the section renders no control at all otherwise.
    const waiting = renderToStaticMarkup(
      <EventDetail row={statusEvent} hasForwardingTarget={true} />,
    );
    expect(waiting).not.toContain("Retry");
    const failed = renderToStaticMarkup(
      <EventDetail
        row={{ ...statusEvent, delivery_status: "failed", delivery_attempts: 6, delivery_last_error: "subscriber returned 502" }}
        hasForwardingTarget={true}
        onRetry={() => undefined}
      />,
    );
    expect(failed).toContain("Retry");
    expect(failed).toContain("subscriber returned 502");
  });

  test("an event with no batch says so rather than inventing a forward state", () => {
    const unlinked: InboundRow = {
      ...statusEvent,
      delivery_id: null,
      delivery_status: null,
      delivery_attempts: null,
      delivery_event_count: null,
    };
    const html = renderToStaticMarkup(<EventDetail row={unlinked} hasForwardingTarget={true} />);
    expect(html).toContain("No forwarding batch is recorded");
  });

  test("a reply names the person who wrote, not the workspace's own number", () => {
    const reply: InboundRow = {
      ...statusEvent,
      id: 78,
      type: "reply",
      transport_message_id: null,
      message_id: "wamid.M1",
      payload: JSON.stringify({ type: "reply", from: "34600000000", messageId: "wamid.M1", text: "hola", at: 1 }),
      outbound_id: null,
      outbound_request: null,
    };
    const html = renderToStaticMarkup(<EventDetail row={reply} hasForwardingTarget={true} />);
    expect(html).toContain(">From<");
    expect(html).toContain("+34600000000");
    // And what they wrote, as a message rather than as a JSON field.
    expect(html).toContain(">hola<");
  });
});

describe("HeldNotice (the third register in which the console says `held`)", () => {
  test("one sentence, and a real door to the page that resolves it", () => {
    // The Status banner's exact anatomy, because it is the same statement about
    // the same system: amber rail, one sentence, a link. A second visual
    // language for it would read as a second condition.
    const html = renderToStaticMarkup(
      <HeldNotice pending={4} hasForwardingTarget={false} wabaId="WABA1" />,
    );
    expect(html).toContain("border-l-[#f0a020]");
    expect(html).toContain("Forwarding is held");
    expect(html).toContain("4 events are waiting");
    expect(html).toContain("nothing has failed");
    expect(html).toContain('href="/webhooks"');
  });

  test("one waiting event is one sentence, not `1 events`", () => {
    expect(
      renderToStaticMarkup(<HeldNotice pending={1} hasForwardingTarget={false} />),
    ).toContain("One event is waiting");
  });

  test("the live region stays mounted and says nothing when nothing is held", () => {
    // An element that appears and disappears is not reliably announced; an
    // empty one that fills up is. Quiet costs no pixels either way — no rail,
    // no margin (data rule 1).
    const withTarget = renderToStaticMarkup(<HeldNotice pending={9} hasForwardingTarget={true} />);
    expect(withTarget).toContain("<output");
    expect(withTarget).not.toContain("Forwarding is held");
    expect(withTarget).not.toContain("border-l-[#f0a020]");
    // Nothing waiting is not held either: a standing scold on a page that is
    // behaving is exactly what data rule 1 forbids.
    expect(
      renderToStaticMarkup(<HeldNotice pending={0} hasForwardingTarget={false} />),
    ).not.toContain("Forwarding is held");
  });
});
