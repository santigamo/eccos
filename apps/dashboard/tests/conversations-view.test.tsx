import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ConversationSummary, MessageRecord } from "../src/server/gateway";

/**
 * The conversation inbox (`routes/conversations.tsx` and
 * `components/conversations/*`), rendered from fixtures.
 *
 * WHAT IS PINNED. Every message type has a reading that shows in the thread
 * (text, media, location, contacts, reactions, edits, revokes, unsupported,
 * placeholders, and an unknown type's own name). The list and thread are
 * addressed by the URL, the mobile layout shows one pane at a time, and the
 * page's empty, failure and pending states are the ones the design contract
 * asks for. The design contract's two static rules (square corners, no dash in
 * UI copy) are checked on the rendered markup of every state.
 *
 * Fixtures use reserved fake numbers (555-01xx) and fake Meta ids only.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

let loaderData: unknown;
let searchParams: { wabaId?: string; waId?: string } = {};
let rootData: unknown;

// SPREAD, not replaced — see tests/templates-screen.test.tsx. The Link stub
// writes its search into the href, so an address can be asserted.
const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  createFileRoute: () => (opts: unknown) => ({
    ...(opts as object),
    useLoaderData: () => loaderData,
    useSearch: () => searchParams,
    useNavigate: () => () => {},
  }),
  Link: (props: {
    to: string;
    search?: Record<string, string | undefined>;
    children: ReactNode;
    className?: string;
    "aria-current"?: "true";
  }) => {
    const query = new URLSearchParams(
      Object.entries(props.search ?? {}).flatMap(([k, v]) => (v ? [[k, v]] : [])),
    ).toString();
    return (
      <a
        href={query ? `${props.to}?${query}` : props.to}
        className={props.className}
        aria-current={props["aria-current"]}
      >
        {props.children}
      </a>
    );
  },
  useLoaderData: () => rootData,
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}));

const { Route } = await import("../src/routes/conversations");
const { ConversationList } = await import("../src/components/conversations/conversation-list");
const { ConversationThread } = await import("../src/components/conversations/conversation-thread");
const { threadEntries } = await import("../src/lib/conversations");

const WABA = "waba-a";
const CUSTOMER = "15550100001";
const NOW = 1_700_000_000_000;

const readyRoot = {
  ok: true,
  data: {
    stage: "ready",
    status: {},
    scope: { accountId: "account-a", selectedWabaId: WABA, resources: { wabas: [], phones: [] } },
  },
};

function message(overrides: Partial<MessageRecord> & Pick<MessageRecord, "id">): MessageRecord {
  return {
    waId: CUSTOMER,
    direction: "in",
    origin: "live",
    type: "text",
    text: null,
    content: null,
    at: NOW,
    status: null,
    error: null,
    targetId: null,
    phoneNumberId: "phone-a",
    ...overrides,
  };
}

const json = (value: unknown) => JSON.stringify(value);

/** One stored message of every type the thread reads, oldest first. */
const THREAD: MessageRecord[] = [
  message({ id: "wamid.in-text", text: "Hola, ¿tenéis cita mañana?", at: NOW }),
  message({ id: "wamid.out-text", direction: "out", status: "read", text: "Sí, a las 10.", at: NOW + 1_000 }),
  message({ id: "wamid.echo-text", direction: "echo", status: "delivered", text: "Confirmado desde la app", at: NOW + 2_000 }),
  message({ id: "wamid.out-failed", direction: "out", status: "failed", error: "131026", text: "Recordatorio", at: NOW + 3_000 }),
  message({ id: "wamid.out-history", direction: "out", origin: "history", status: "sent", text: "Mensaje importado", at: NOW + 4_000 }),
  message({ id: "wamid.in-image", type: "image", text: "Mi receta", content: json({ media: { id: "media-image-1", caption: "Mi receta" } }), at: NOW + 5_000 }),
  message({ id: "wamid.in-sticker", type: "sticker", content: json({ media: { id: "media-sticker-1" } }), at: NOW + 6_000 }),
  message({ id: "wamid.in-audio", type: "audio", content: json({ media: { id: "media-audio-1" } }), at: NOW + 7_000 }),
  message({ id: "wamid.in-video", type: "video", content: json({ media: { id: "media-video-1" } }), at: NOW + 8_000 }),
  message({ id: "wamid.in-document", type: "document", content: json({ media: { id: "media-document-1", filename: "presupuesto.pdf" } }), at: NOW + 9_000 }),
  message({ id: "wamid.in-location", type: "location", content: json({ location: { latitude: 40.4168, longitude: -3.7038, name: "Consulta", address: "Calle Ejemplo 1" } }), at: NOW + 10_000 }),
  message({ id: "wamid.in-contacts", type: "contacts", content: json({ contacts: [{ name: { formatted_name: "Ana Ejemplo" }, phones: [{ phone: "+15550100003" }] }] }), at: NOW + 11_000 }),
  message({ id: "wamid.in-reacted", text: "¿Confirmas?", at: NOW + 12_000 }),
  message({ id: "wamid.react", type: "reaction", targetId: "wamid.in-reacted", content: json({ reaction: { messageId: "wamid.in-reacted", emoji: "👍" } }), at: NOW + 13_000 }),
  message({ id: "wamid.edit", type: "edit", direction: "echo", text: "Sí, a las 10:30.", targetId: "wamid.out-text", content: json({ originalMessageId: "wamid.out-text" }), at: NOW + 14_000 }),
  message({ id: "wamid.in-revoked", text: "Esto se borra", at: NOW + 15_000 }),
  message({ id: "wamid.revoke", type: "revoke", targetId: "wamid.in-revoked", content: json({ originalMessageId: "wamid.in-revoked" }), at: NOW + 16_000 }),
  message({ id: "wamid.unsupported", type: "unsupported", content: json({ errorCode: "131051", errorMessage: "Unsupported" }), at: NOW + 17_000 }),
  message({ id: "wamid.placeholder", type: "media_placeholder", at: NOW + 18_000 }),
  message({ id: "wamid.poll", type: "poll", at: NOW + 19_000 }),
  message({ id: "wamid.orphan-reaction", type: "reaction", targetId: "wamid.gone", content: json({ reaction: { messageId: "wamid.gone", emoji: "🎉" } }), at: NOW + 20_000 }),
];

const SUMMARY: ConversationSummary = {
  waId: CUSTOMER,
  name: "Cliente de prueba",
  messageCount: THREAD.length,
  lastMessage: { type: "poll", text: null, direction: "in", at: NOW + 19_000 },
};

const page = <T,>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });

function threadProps(overrides: Partial<Parameters<typeof ConversationThread>[0]> = {}) {
  return {
    wabaId: WABA,
    title: "Cliente de prueba",
    entries: threadEntries(THREAD),
    canLoadOlder: false,
    loadingOlder: false,
    olderFailed: false,
    onLoadOlder: () => {},
    ...overrides,
  };
}

/** The design contract's two static rules, applied to any rendered state. */
function expectDesignContract(html: string) {
  // Nothing rounds a corner: the only radius class the console may render is `rounded-none`.
  expect(html.match(/rounded-(?!none)[a-z0-9-]*/g) ?? []).toEqual([]);
  // No dash in UI copy: no em dash and no en dash.
  expect(html).not.toContain("—");
  expect(html).not.toContain("–");
}

describe("ConversationThread: every message type reads", () => {
  test("text, direction labels and the staff's two ways of sending", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Hola, ¿tenéis cita mañana?");
    expect(html).toContain("Customer");
    expect(html).toContain("Sent via Eccos");
    expect(html).toContain("Sent from the WhatsApp Business app");
    expect(html).toContain("Confirmado desde la app");
  });

  test("an outgoing message shows what Meta last said, and a failure says why", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("read");
    expect(html).toContain("delivered");
    expect(html).toContain("failed: 131026");
  });

  test("a history import is marked as one", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Imported history");
  });

  test("images and stickers come from the media route, with their caption", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain('src="/media/waba-a/media-image-1"');
    expect(html).toContain('src="/media/waba-a/media-sticker-1"');
    expect(html).toContain('alt="Sticker"');
    expect(html).toContain("Mi receta");
  });

  test("audio and video play in place", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("<audio");
    expect(html).toContain('src="/media/waba-a/media-audio-1"');
    expect(html).toContain("<video");
    expect(html).toContain('src="/media/waba-a/media-video-1"');
  });

  test("a document is a link named by its file, with a note that it may be unavailable", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain('href="/media/waba-a/media-document-1"');
    expect(html).toContain('download="presupuesto.pdf"');
    expect(html).toContain(">presupuesto.pdf<");
    expect(html).toContain("May be unavailable");
  });

  test("a location names its place and links to a map", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Consulta");
    expect(html).toContain("Calle Ejemplo 1");
    expect(html).toContain("query=40.4168,-3.7038");
    expect(html).toContain("Open in maps");
  });

  test("contacts show their names and numbers", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Ana Ejemplo");
    expect(html).toContain("+15550100003");
  });

  test("a reaction sits on the message it reacted to, not as a row of its own", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain('aria-label="Reactions"');
    expect(html).toContain("👍");
    expect(html).not.toContain("Reacted 👍 to a message");
  });

  test("an edit shows the new text and marks the message edited", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Sí, a las 10:30.");
    expect(html).not.toContain("Sí, a las 10.");
    expect(html).toContain("<span>Edited</span>");
  });

  test("a revoke replaces its target with Message deleted", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Message deleted");
    expect(html).not.toContain("Esto se borra");
  });

  test("an unsupported message says so and gives Meta's error code", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Unsupported message");
    expect(html).toContain("Error code 131051");
  });

  test("a placeholder says the media is not available", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Media not available");
  });

  test("an unknown type shows its own name", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain(">poll<");
  });

  test("a reaction whose message is not in the page stays as a line", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps()} />);
    expect(html).toContain("Reacted 🎉 to a message");
  });

  test("every state of the thread honours the design contract", () => {
    expectDesignContract(renderToStaticMarkup(<ConversationThread {...threadProps()} />));
  });
});

describe("ConversationThread: pagination and empty states", () => {
  test("Load older is shown only while there is an older page, or one is loading", () => {
    const more = renderToStaticMarkup(<ConversationThread {...threadProps({ canLoadOlder: true })} />);
    expect(more).toMatch(/<button[^>]*>← Load older/);
    expect(more).not.toMatch(/<button[^>]* disabled=""[^>]*>← Load older/);
    const loading = renderToStaticMarkup(<ConversationThread {...threadProps({ canLoadOlder: false, loadingOlder: true })} />);
    expect(loading).toMatch(/<button[^>]* disabled=""[^>]*>← Load older/);
    const done = renderToStaticMarkup(<ConversationThread {...threadProps({ canLoadOlder: false })} />);
    expect(done).not.toContain("Load older");
  });

  test("a failed older page says so beside the control", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps({ olderFailed: true })} />);
    expect(html).toContain("Messages did not load. Try again.");
  });

  test("a thread with nothing in the retained history says so", () => {
    const html = renderToStaticMarkup(<ConversationThread {...threadProps({ entries: [] })} />);
    expect(html).toContain("NO MESSAGES");
    expect(html).not.toContain("Load older");
  });
});

describe("ConversationList", () => {
  const listProps = {
    wabaId: WABA,
    now: NOW + 60_000,
    canLoadOlder: true,
    loadingOlder: false,
    olderFailed: false,
    onLoadOlder: () => {},
  };

  test("each row is a link to its thread, and the open one is marked current", () => {
    const html = renderToStaticMarkup(
      <ConversationList {...listProps} items={[SUMMARY]} selectedWaId={CUSTOMER} />,
    );
    expect(html).toContain(`href="/conversations?wabaId=waba-a&amp;waId=${CUSTOMER}"`);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Cliente de prueba");
  });

  test("a number with no name is shown as the number", () => {
    const html = renderToStaticMarkup(
      <ConversationList {...listProps} items={[{ ...SUMMARY, name: null }]} />,
    );
    expect(html).toContain(`+${CUSTOMER}`);
  });

  test("the preview names the last message and its kind, with a relative time", () => {
    const html = renderToStaticMarkup(
      <ConversationList {...listProps} items={[{ ...SUMMARY, lastMessage: { type: "image", text: null, direction: "out", at: NOW } }]} />,
    );
    expect(html).toContain("You: Photo");
    expect(html).toContain("1 min ago");
    expect(html).toContain(`${THREAD.length}<span class="sr-only"> messages</span>`);
  });

  test("with no conversations yet, the list says what will appear and offers no pager", () => {
    const html = renderToStaticMarkup(<ConversationList {...listProps} items={[]} />);
    expect(html).toContain("NO CONVERSATIONS YET");
    expect(html).not.toContain("Load older");
  });

  test("Load older is shown only while there is an older page, or one is loading", () => {
    const more = renderToStaticMarkup(<ConversationList {...listProps} items={[SUMMARY]} />);
    expect(more).not.toMatch(/<button[^>]* disabled=""[^>]*>Load older →/);
    const loading = renderToStaticMarkup(<ConversationList {...listProps} items={[SUMMARY]} canLoadOlder={false} loadingOlder />);
    expect(loading).toMatch(/<button[^>]* disabled=""[^>]*>Load older →/);
    const done = renderToStaticMarkup(<ConversationList {...listProps} items={[SUMMARY]} canLoadOlder={false} />);
    expect(done).not.toContain("Load older");
  });

  test("every state of the list honours the design contract", () => {
    expectDesignContract(renderToStaticMarkup(<ConversationList {...listProps} items={[SUMMARY]} />));
    expectDesignContract(renderToStaticMarkup(<ConversationList {...listProps} items={[]} />));
  });
});

describe("the inbox's source", () => {
  test("no file in the inbox rounds a corner, including branches a render never reaches", async () => {
    const files = [new URL("../src/routes/conversations.tsx", import.meta.url).pathname];
    for await (const file of new Bun.Glob("**/*.tsx").scan({
      cwd: new URL("../src/components/conversations", import.meta.url).pathname,
      absolute: true,
    })) {
      files.push(file);
    }
    const offenders: string[] = [];
    for (const file of files) {
      if (/rounded-(?!none)/.test(await Bun.file(file).text())) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the conversations page", () => {
  const ready = (conversations: unknown, thread: unknown = null) => {
    loaderData = { conversations, thread };
    rootData = readyRoot;
  };

  test("with a number selected, the thread shows and the list steps aside on a phone", () => {
    searchParams = { wabaId: WABA, waId: CUSTOMER };
    ready({ ok: true, data: page([SUMMARY]) }, { ok: true, data: { page: page(THREAD, "cursor-2"), name: "Cliente de prueba", reply: { phoneNumberId: "phone-a", lastInboundAt: null } } });
    const html = renderToStaticMarkup(<Route.component />);
    // The mobile contract: a selected thread hides the list below md, and the
    // thread takes the whole row. Desktop shows both.
    expect(html).toMatch(/data-pane="list" class="hidden [^"]*md:flex/);
    expect(html).toMatch(/data-pane="thread" class="flex /);
    expect(html).toContain("← Conversations");
    expect(html).toContain("Hola, ¿tenéis cita mañana?");
    expectDesignContract(html);
  });

  test("the gateway's oldest-first page is read as it arrives: the first message on top, the newest at the bottom", () => {
    searchParams = { wabaId: WABA, waId: CUSTOMER };
    ready({ ok: true, data: page([SUMMARY]) }, { ok: true, data: { page: page(THREAD, "cursor-2"), name: null, reply: { phoneNumberId: "phone-a", lastInboundAt: null } } });
    const html = renderToStaticMarkup(<Route.component />);
    const first = html.indexOf("Hola, ¿tenéis cita mañana?");
    const reply = html.indexOf("Sí, a las 10:30.");
    const failed = html.indexOf("Recordatorio");
    expect(first).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(first);
    expect(failed).toBeGreaterThan(reply);
  });

  test("a thread whose number is past the list's first page is titled by its name", () => {
    searchParams = { wabaId: WABA, waId: CUSTOMER };
    ready({ ok: true, data: page([]) }, { ok: true, data: { page: page(THREAD), name: "Cliente de prueba", reply: { phoneNumberId: "phone-a", lastInboundAt: null } } });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toContain('<h2 class="truncate text-base font-medium text-foreground">Cliente de prueba</h2>');
  });

  test("a number nobody named is titled with its digits, written as a number", () => {
    searchParams = { wabaId: WABA, waId: CUSTOMER };
    ready({ ok: true, data: page([]) }, { ok: true, data: { page: page(THREAD), name: null, reply: { phoneNumberId: "phone-a", lastInboundAt: null } } });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toContain(`>+${CUSTOMER}</h2>`);
    expect(html).not.toContain(`++${CUSTOMER}`);
  });

  test("the page's kicker is the nav group the page sits in", () => {
    searchParams = { wabaId: WABA };
    ready({ ok: true, data: page([SUMMARY]) });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toContain("Inbox");
    expect(html).not.toContain("Logs");
  });

  test("with no number selected, the list fills a phone and the thread waits for a choice", () => {
    searchParams = { wabaId: WABA };
    ready({ ok: true, data: page([SUMMARY]) });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toMatch(/data-pane="list" class="flex /);
    expect(html).toMatch(/data-pane="thread" class="hidden min-h-0 min-w-0 flex-1 flex-col md:flex"/);
    expect(html).toContain("NO CONVERSATION OPEN");
    expect(html).toContain(`href="/conversations?wabaId=waba-a&amp;waId=${CUSTOMER}"`);
  });

  test("a number with no conversations yet says so, with the thread still waiting", () => {
    searchParams = { wabaId: WABA };
    ready({ ok: true, data: page([]) });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toContain("NO CONVERSATIONS YET");
    expect(html).toContain("NO CONVERSATION OPEN");
  });

  test("the refresh and live controls are on the page, as on Events and Messages", () => {
    searchParams = { wabaId: WABA };
    ready({ ok: true, data: page([SUMMARY]) });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toContain("Refresh");
    expect(html).toContain("Live off");
  });

  test("a gateway failure on the list replaces the page with the failure view", () => {
    searchParams = { wabaId: WABA };
    ready({ ok: false, kind: "unreachable", error: "boom" });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toContain("Gateway unreachable");
    expect(html).toContain("boom");
    expect(html).not.toContain('data-pane="list"');
  });

  test("a failure on one thread leaves the list and says what failed", () => {
    searchParams = { wabaId: WABA, waId: CUSTOMER };
    ready({ ok: true, data: page([SUMMARY]) }, { ok: false, kind: "unreachable", error: "thread boom" });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).toContain("Cliente de prueba");
    expect(html).toContain("thread boom");
    expect(html).toContain('data-pane="thread"');
  });

  test("a forbidden read says what the operator can do, not that the gateway is down", () => {
    searchParams = { wabaId: WABA };
    ready({ ok: false, kind: "forbidden", reason: "missing-permission", error: "missing view" });
    const html = renderToStaticMarkup(<Route.component />);
    expect(html).not.toContain("Gateway unreachable");
    expect(html).toContain("Not available to your role");
  });

  test("while the loader runs the page shows its own title over skeleton panes", () => {
    const html = renderToStaticMarkup(<Route.pendingComponent />);
    expect(html).toContain("Conversations");
    expect(html).toContain('aria-busy="true"');
    expectDesignContract(html);
  });
});

describe("the reply box on a thread", () => {
  /** A thread whose customer last wrote 20 h 30 min ago: 3 h 30 min of window left. */
  const OPEN_AT = () => Date.now() - (20 * 3600 + 30 * 60) * 1000;
  const DAY_AND_A_BIT_AGO = () => Date.now() - 25 * 3600 * 1000;

  function renderThread(canSend: boolean | undefined, lastInboundAt: number | null) {
    searchParams = { wabaId: WABA, waId: CUSTOMER };
    loaderData = {
      conversations: { ok: true, data: page([SUMMARY]) },
      thread: {
        ok: true,
        data: { page: page(THREAD, "cursor-2"), name: null, reply: { phoneNumberId: "phone-a", lastInboundAt } },
      },
      canSend,
    };
    rootData = readyRoot;
    return renderToStaticMarkup(<Route.component />);
  }

  test("inside the window, a member gets the window in words and a reply box, and Send", () => {
    const html = renderThread(true, OPEN_AT());
    expect(html).toContain("Window open, 3 h left");
    expect(html).toContain("<textarea");
    expect(html).toContain(">Send</button>");
    expect(html).not.toContain("Send a template");
    expectDesignContract(html);
  });

  test("outside the window the box gives way to the template path, and says why", () => {
    const html = renderThread(true, DAY_AND_A_BIT_AGO());
    expect(html).toContain("Window closed: templates only");
    expect(html).toContain("Send a template");
    expect(html).not.toContain("<textarea");
    expectDesignContract(html);
  });

  test("a customer who never wrote is the same closed state, not an open one", () => {
    const html = renderThread(true, null);
    expect(html).toContain("Window closed: templates only");
    expect(html).not.toContain("<textarea");
  });

  test("a viewer sees the thread and no composer at all, whatever the window", () => {
    for (const canSend of [false, undefined]) {
      const html = renderThread(canSend, OPEN_AT());
      expect(html).toContain("Hola, ¿tenéis cita mañana?");
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain("Window open");
      expect(html).not.toContain("Window closed");
    }
  });
});
