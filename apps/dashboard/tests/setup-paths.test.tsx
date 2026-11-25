import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The post-connect setup wizard in a real DOM: the goal chooser, each path's
 * live test moved only by what the stubbed reads return, and the paywall,
 * both optimistic (a test succeeded here) and from the server's activation.
 */

GlobalRegistrator.register({ url: "http://localhost:3000/setup" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

type Fn = (input?: unknown) => Promise<unknown>;
const gateway = await import("../src/server/gateway");
const NAMES = [
  "listConversations",
  "listOutbound",
  "listInbound",
  "sendText",
  "setSubscriberConfig",
  "issueApiKey",
  "sendTemplateTest",
  "startCheckout",
] as const;
type Name = (typeof NAMES)[number];
const unset: Fn = async () => ({ ok: false, kind: "unreachable", error: "not stubbed" });
// The mock is process-global: later files must get the real functions back.
const real = Object.fromEntries(NAMES.map((n) => [n, gateway[n] as unknown as Fn])) as Record<Name, Fn>;
let stubs: Record<Name, Fn> = Object.fromEntries(NAMES.map((n) => [n, unset])) as Record<Name, Fn>;
const calls: Record<string, unknown[]> = {};
mock.module("../src/server/gateway", () => ({
  ...gateway,
  ...Object.fromEntries(
    NAMES.map((name) => [
      name,
      (input?: unknown) => {
        calls[name] = [...(calls[name] ?? []), input];
        return stubs[name](input);
      },
    ]),
  ),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SetupWizard } = await import("../src/components/setup-paths/setup-wizard");
const { exchangeProof } = await import("../src/components/setup-paths/use-latest-exchange");
const { openAfterHydration } = await import("../src/components/setup-paths/activation-dialog");
const { SetupPaused } = await import("../src/components/setup-paths/setup-paused");

const START = 1_000_000_000_000;
const ok = (data: unknown) => async () => ({ ok: true, data });
const page = (items: unknown[]) => ok({ items, nextCursor: null });

let unmount: (() => void) | null = null;
let navigated: string[] = [];

beforeEach(() => {
  navigated = [];
  for (const key of Object.keys(calls)) delete calls[key];
  stubs = {
    ...(Object.fromEntries(NAMES.map((n) => [n, unset])) as Record<Name, Fn>),
    listConversations: page([]),
    listOutbound: ok([]),
    listInbound: ok([]),
  };
});

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  document.body.innerHTML = "";
});

afterAll(async () => {
  stubs = { ...real };
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 5))));

async function wizard(props: Partial<Parameters<typeof SetupWizard>[0]> = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SetupWizard
        wabaId="100"
        phoneNumberId="200"
        phone="+34 612 345 678"
        gatewayOrigin="https://api.eccos.test"
        numbers={1}
        canManage
        offer
        activation={null}
        navigate={(path) => navigated.push(path)}
        now={() => START}
        {...props}
      />,
    ),
  );
  unmount = () => root.unmount();
  await settle();
  return host;
}

function control(host: HTMLElement, text: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>("button, a")].find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`no control "${text}" in: ${host.textContent}`);
  return found;
}
const press = async (host: HTMLElement, text: string) => {
  await act(async () => control(host, text).click());
  await settle();
};
const heading = (host: HTMLElement) => host.querySelector("h2")?.textContent ?? "";

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const arrived = {
  waId: "34600111222",
  name: null,
  messageCount: 1,
  unreadCount: 1,
  markedUnread: false,
  lastMessage: { type: "text", text: "Hello, this is a test", direction: "in", at: START + 1_000 },
};
const deliveredTrail = (at: number) => [{ type: "delivered", at, errorCode: null, deliveryStatus: null, deliveryAttempts: null }];

function expectPaywall(host: HTMLElement) {
  expect(heading(host)).toBe("It works. Your number is live on Eccos.");
  expect(host.textContent).toContain("5 € per month");
  expect(host.textContent).toContain("Start subscription · 5 €/month");
  expect(host.textContent).toContain("Continue to the console");
  expect(host.textContent?.toLowerCase()).not.toContain("free");
}

describe("goal chooser", () => {
  test("offers the three paths, with the connected number", async () => {
    const host = await wizard();
    expect(heading(host)).toBe("Your number is connected. What do you want to do first?");
    expect(host.textContent).toContain("+34 612 345 678");
    for (const goal of ["Just answer from Eccos", "Connect it to my tool", "Send from my software"]) control(host, goal);
    expect(host.textContent).toContain("Step 5 of 6");
  });
});

describe("path A: reply from Eccos", () => {
  test("a message in, a reply sent from the wizard, Meta's delivered receipt: the paywall with the real exchange", async () => {
    const host = await wizard();
    await press(host, "Just answer from Eccos");
    expect(heading(host)).toBe("Send a WhatsApp to your own number");
    expect(host.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toContain("+34 612 345 678");
    expect(control(host, "Skip the test and open the inbox").getAttribute("href")).toBe("/conversations");

    // The next poll sees the message: remount the read by stepping back and in.
    stubs.listConversations = page([arrived]);
    await press(host, "Back");
    await press(host, "Just answer from Eccos");
    expect(heading(host)).toBe("It arrived. Now answer it.");
    expect(host.textContent).toContain("Hello, this is a test");

    stubs.sendText = ok({ ok: true, messageId: "wamid.reply" });
    stubs.listOutbound = ok([
      { id: 1, transport_message_id: "wamid.reply", recipient: "34600111222", phone_number_id: "200", request: "{}", status: "sent", error: null, created_at: START, trail: deliveredTrail(START + 60_000) },
    ]);
    await press(host, "Send reply");
    const sent = calls.sendText?.[0] as { data: Record<string, unknown> };
    expect(sent.data).toMatchObject({ wabaId: "100", phoneNumberId: "200", to: "34600111222", text: "Hi! We got your message." });

    expectPaywall(host);
    expect(host.textContent).toContain("Hi! We got your message.");
    expect(host.textContent).toContain("Delivered to +34600111222");
  });

  test("a reply the gateway could not send reads in the console's words, never the server's", async () => {
    stubs.listConversations = page([arrived]);
    const host = await wizard();
    await press(host, "Just answer from Eccos");
    stubs.sendText = async () => ({ ok: false, kind: "unreachable", error: "internal error; reference = 7f3a" });
    await press(host, "Send reply");
    expect(host.textContent).toContain("We couldn't send the reply. Try again in a moment.");
    expect(host.textContent).not.toContain("internal error");
  });
});

describe("path B: connect my tool", () => {
  async function toTest(host: HTMLElement) {
    await press(host, "Connect it to my tool");
    expect(heading(host)).toBe("Which tool should get your messages?");
    await press(host, "Make");
    expect(heading(host)).toBe("Get your webhook address from Make");
    stubs.setSubscriberConfig = ok({ ok: true, savedAt: START });
    await type(host.querySelector<HTMLInputElement>('input[type="url"]') as HTMLInputElement, "https://hook.eu2.make.com/abc");
    await press(host, "Save and test");
  }

  test("the address is saved as the forwarding target, and the live test starts listening", async () => {
    const host = await wizard();
    await toTest(host);
    expect(calls.setSubscriberConfig?.[0]).toEqual({ data: { url: "https://hook.eu2.make.com/abc", wabaId: "100" } });
    expect(heading(host)).toBe("Now send a WhatsApp to your number");
    expect(host.textContent).toContain("Waiting for a message on your number");
  });

  test("your tool doesn't answer: the refusal with its status, then Try again listens afresh", async () => {
    const host = await wizard();
    stubs.listInbound = ok([
      {
        id: 1,
        type: "reply",
        transport_message_id: null,
        message_id: "wamid.in",
        phone_number_id: "200",
        payload: JSON.stringify({ from: "34600111222", text: "Hello, this is a test" }),
        received_at: START + 1_000,
        delivery_status: "pending",
        delivery_attempts: 1,
        delivery_last_error: "subscriber returned 404",
      },
    ]);
    await toTest(host);
    expect(heading(host)).toBe("Your message arrived, but Make did not accept it");
    expect(host.textContent).toContain("Make answered 404");

    stubs.listInbound = ok([
      {
        id: 2,
        type: "reply",
        transport_message_id: null,
        message_id: "wamid.in2",
        phone_number_id: "200",
        payload: JSON.stringify({ from: "34600111222", text: "Second try" }),
        received_at: START + 2_000,
        delivery_status: "delivered",
        delivery_finished_at: START + 3_000,
      },
    ]);
    await press(host, "Try again");
    expectPaywall(host);
    expect(host.textContent).toContain("Second try");
    expect(host.textContent).toContain("Make accepted it at");
  });

  const unreadable = (overrides: Record<string, unknown>) => ({
    id: 3,
    type: "reply",
    transport_message_id: null,
    message_id: "wamid.in3",
    phone_number_id: "200",
    payload: JSON.stringify({ from: "34600111222", text: "Hello" }),
    received_at: START + 1_000,
    delivery_status: "pending",
    delivery_attempts: 1,
    delivery_last_error: "internal error; reference = 9c1e",
    ...overrides,
  });

  test("an address that cannot be reached says so honestly, with no raw provider text", async () => {
    const host = await wizard();
    stubs.listInbound = ok([unreadable({})]);
    await toTest(host);
    expect(heading(host)).toBe("We couldn't reach that address");
    expect(host.textContent).toContain("Check it's correct and your scenario is on.");
    expect(host.textContent).not.toContain("internal error");
    expect(host.textContent).not.toContain("answered with an error");
  });

  test("a message received before the address was saved never decides the test", async () => {
    const host = await wizard();
    stubs.listInbound = ok([unreadable({ received_at: START - 1_000, delivery_status: "delivered", delivery_finished_at: START + 1_000 })]);
    await toTest(host);
    expect(heading(host)).toBe("Now send a WhatsApp to your number");
  });

  test("a refused save reads in the console's words", async () => {
    const host = await wizard();
    await press(host, "Connect it to my tool");
    await press(host, "Make");
    stubs.setSubscriberConfig = async () => ({ ok: false, kind: "forbidden", error: "invalid subscriber url: private host" });
    await type(host.querySelector<HTMLInputElement>('input[type="url"]') as HTMLInputElement, "https://hook.eu2.make.com/abc");
    await press(host, "Save and test");
    expect(host.textContent).toContain("We couldn't save that address. Check it's the full link and try again.");
    expect(host.textContent).not.toContain("private host");
  });

  test("an address that is not https cannot be saved", async () => {
    const host = await wizard();
    await press(host, "Connect it to my tool");
    await press(host, "n8n");
    await type(host.querySelector<HTMLInputElement>('input[type="url"]') as HTMLInputElement, "http://example.com");
    expect((control(host, "Save and test") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("path C: send from my software", () => {
  test("a key, a copy-paste example to the operator's phone, and a delivered send: the paywall", async () => {
    const host = await wizard();
    await press(host, "Send from my software");
    expect(heading(host)).toBe("Create your API key");
    stubs.issueApiKey = ok({ keyId: "k1", apiKey: "ek_live_secret" });
    await press(host, "Create key");
    expect(heading(host)).toBe("Send a test to your own phone");
    expect(host.textContent).toContain("ek_live_secret");

    await type(host.querySelector<HTMLInputElement>('input[type="tel"]') as HTMLInputElement, "+34 600 111 222");
    const example = host.querySelector("pre")?.textContent ?? "";
    expect(example).toContain("https://api.eccos.test/v1/wabas/100/messages");
    expect(example).toContain('"to": "34600111222"');
    expect(example).toContain("Bearer ek_live_secret");

    stubs.sendTemplateTest = ok({ ok: true, messageId: "wamid.hw" });
    stubs.listOutbound = ok([
      { id: 9, transport_message_id: "wamid.hw", recipient: "34600111222", phone_number_id: "200", request: "{}", status: "sent", error: null, created_at: START, trail: deliveredTrail(START + 5_000) },
    ]);
    await press(host, "No terminal? Send it from here");
    expect((calls.sendTemplateTest?.[0] as { data: unknown }).data).toMatchObject({
      wabaId: "100",
      phoneNumberId: "200",
      to: "34600111222",
      templateName: "hello_world",
      languageCode: "en_US",
    });
    // The poll's next tick reads the delivered send.
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 3_100))));
    expectPaywall(host);
    expect(host.textContent).toContain("Hello World");
  });
});

describe("activation paywall", () => {
  const activation = { activatedAt: Date.parse("2026-11-25T10:00:00Z"), pausesAt: Date.now() + 10.5 * 3_600_000 };

  test("the server's activation shows it at once, with the time the window has left, as the strip reads it", async () => {
    const host = await wizard({ activation });
    expectPaywall(host);
    expect(host.textContent).toContain("Your setup window has 10 h left");
    expect(host.textContent).toContain("Step 6 of 6");
  });

  test("Start subscription calls the existing checkout; the 72h route is a quiet link onward", async () => {
    stubs.startCheckout = async () => ({ ok: false, kind: "unreachable", error: "down" });
    const host = await wizard({ activation });
    await press(host, "Start subscription");
    expect(calls.startCheckout?.length).toBe(1);
    expect(host.textContent).toContain("Billing could not be opened");
    await press(host, "Continue to the console");
    expect(navigated).toEqual(["/"]);
  });

  test("a member who cannot subscribe is told who can", async () => {
    const host = await wizard({ activation, canManage: false });
    expect(host.textContent).not.toContain("Start subscription");
    expect(host.textContent).toContain("Ask an owner or admin");
  });

  test("without billing, a success ends without a price", async () => {
    const host = await wizard({ activation, offer: false });
    expect(heading(host)).toBe("It works. Your number is live on Eccos.");
    expect(host.textContent).not.toContain("€");
  });
});

describe("proof read back for a server-side activation", () => {
  const record = (id: string, direction: string, at: number, status: string | null = null, text: string | null = id) => ({
    id,
    waId: "34600111222",
    direction,
    origin: "live",
    type: "text",
    text,
    content: null,
    at,
    status,
    error: null,
    targetId: null,
    phoneNumberId: "200",
  });

  test("the newest written messages, oldest first, and when the last one was delivered", () => {
    const proof = exchangeProof("34600111222", [
      record("reply", "out", 4, "delivered"),
      record("echo", "echo", 3),
      record("hello", "in", 2),
      record("image", "in", 1, null, null),
    ] as never);
    expect(proof?.title).toBe("+34600111222");
    expect(proof?.messages.map((m) => [m.text, m.direction, m.delivered])).toEqual([
      ["hello", "in", false],
      ["reply", "out", true],
    ]);
  });

  test("nothing written, no proof", () => {
    expect(exchangeProof("1", [record("x", "in", 1, null, null)] as never)).toBeNull();
  });
});

describe("paused and page-load states", () => {
  test("a paused workspace is told to subscribe first, with no live test that cannot pass", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<SetupPaused />));
    unmount = () => root.unmount();
    expect(heading(host)).toBe("Subscribe to resume, then test");
    expect(host.textContent).not.toContain("Waiting for");
    expect(host.querySelector("button")).toBeNull();
  });

  test("the activation dialog opens after the page settles, not during hydration", async () => {
    let opened = 0;
    openAfterHydration(() => opened++);
    const cancel = openAfterHydration(() => opened++);
    cancel();
    expect(opened).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(opened).toBe(1);
  });
});
