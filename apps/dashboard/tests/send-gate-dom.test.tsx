import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The send gate, driven through a real DOM (happy-dom): clicks, submits and
 * key presses reach the forms the way a browser's do, which a static-markup
 * test cannot. Each case here once sent a real WhatsApp message twice.
 *
 * The DOM is registered for this file only and removed after it, so the
 * static-markup files keep their server rendering.
 */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  useRouter: () => ({ invalidate: async () => {} }),
  Link: (props: { children: ReactNode }) => <a href="/messages">{props.children}</a>,
}));

// SPREAD, delegating: every other export stays real, and the two sends fall back
// to the real ones after this file, for whichever file imports the module next.
// The real sends are captured BEFORE mock.module: it retro-patches `gateway`'s
// live bindings, so reading `gateway.sendText` afterwards returns the wrapper
// below, and a wrapper delegating to itself is a tail call JSC loops on forever.
const gateway = await import("../src/server/gateway");
const realSendTemplateTest = gateway.sendTemplateTest as (input: unknown) => Promise<unknown>;
const realSendText = gateway.sendText as (input: unknown) => Promise<unknown>;
let sendTemplateTest = realSendTemplateTest;
let sendText = realSendText;
mock.module("../src/server/gateway", () => ({
  ...gateway,
  sendTemplateTest: (input: unknown) => sendTemplateTest(input),
  sendText: (input: unknown) => sendText(input),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SendTestForm } = await import("../src/components/templates/send-test-sheet");
const { ConversationComposer } = await import("../src/components/conversations/conversation-composer");
const { analyzeTemplate } = await import("../src/lib/template-params");

const PHONES = [{ phoneNumberId: "PNID1", displayPhoneNumber: "+34600000000" }];
const SENT = { ok: true, data: { ok: true, messageId: "wamid.sent-1" } };

let unmount: (() => void) | null = null;

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  document.body.innerHTML = "";
  sendTemplateTest = realSendTemplateTest;
  sendText = realSendText;
});

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmount = () => root.unmount();
  return host;
}

/** Types into a controlled field the way a browser does, so React sees the change. */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

/** The conversation's "Send a template" form: the recipient fixed to the customer, one parameter. */
async function mountConversationForm(): Promise<HTMLElement> {
  const host = await mount(
    <SendTestForm
      wabaId="waba-a"
      templateName="hello_world"
      languageCode="en_US"
      sendability={analyzeTemplate({ components: [{ type: "BODY", text: "Hi {{1}}" }] })}
      phones={PHONES}
      initialPhoneNumberId="PNID1"
      recipient="15550100001"
    />,
  );
  await act(async () => type(host.querySelector<HTMLInputElement>("#send-test-param-1")!, "Ana"));
  return host;
}

describe("SendTestForm in a real DOM", () => {
  test("two quick submits send once", async () => {
    const send = mock(async () => SENT);
    sendTemplateTest = send;
    const host = await mountConversationForm();
    const submit = button(host, "Send test message");

    await act(async () => {
      submit.click();
      submit.click();
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("wamid.sent-1");
  });

  test("a double click on Send another after a send does not send again", async () => {
    const send = mock(async () => SENT);
    sendTemplateTest = send;
    const host = await mountConversationForm();

    await act(async () => button(host, "Send test message").click());
    expect(send).toHaveBeenCalledTimes(1);

    const another = button(host, "Send another");
    // Both clicks of a double click land on the node the pointer is over.
    await act(async () => another.click());
    await act(async () => another.click());

    expect(send).toHaveBeenCalledTimes(1);
    // And the next payload starts empty, not a copy of the one just sent.
    expect(host.querySelector<HTMLInputElement>("#send-test-param-1")?.value).toBe("");
  });

  test("a thrown send shows a notice and stays retryable", async () => {
    const send = mock(async (): Promise<unknown> => {
      throw new Error("network");
    });
    sendTemplateTest = send;
    const host = await mountConversationForm();

    await act(async () => button(host, "Send test message").click());

    expect(host.querySelector("output")?.textContent).toContain("Send failed");
    const submit = button(host, "Send test message");
    expect(submit.disabled).toBe(false);

    send.mockImplementation(async () => SENT);
    await act(async () => submit.click());
    expect(send).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("wamid.sent-1");
  });
});

describe("ConversationComposer in a real DOM", () => {
  test("Enter held through a successful send does not resend the old text", async () => {
    let accept: (value: unknown) => void = () => {};
    const send = mock(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    sendText = send;
    const now = Date.now();
    const host = await mount(
      <ConversationComposer
        wabaId="waba-a"
        waId="15550100001"
        phoneNumberId="PNID1"
        phones={PHONES}
        lastInboundAt={now}
        now={now}
      />,
    );
    const textarea = host.querySelector("textarea")!;
    await act(async () => type(textarea, "hola"));

    const enter = () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await act(async () => enter());
    expect(send).toHaveBeenCalledTimes(1);

    // The send lands and the key repeats before the cleared box has rendered.
    await act(async () => {
      accept({ ok: true, data: { ok: true, messageId: "wamid.reply-1" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      enter();
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");

    // Typing a new reply opens the gate again.
    await act(async () => type(textarea, "otra"));
    await act(async () => enter());
    expect(send).toHaveBeenCalledTimes(2);
  });
});
