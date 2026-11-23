import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/** The invite form in a real DOM (happy-dom): a thrown call and the field's own validity. */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { InviteMemberForm } = await import("../src/components/dashboard/invite-member-sheet");
const { MEMBERS_RETRY } = await import("../src/lib/members-copy");

let unmount: (() => void) | null = null;

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  document.body.innerHTML = "";
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

function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("InviteMemberForm", () => {
  test("a call that throws shows the retry line instead of resetting silently", async () => {
    // An empty workspace id fails the server function's validator, which throws.
    const host = await mount(<InviteMemberForm organizationId="" />);
    await act(async () => type(host.querySelector<HTMLInputElement>("#invite-email")!, "ana@empresa.com"));
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector("output")!.textContent).toBe(MEMBERS_RETRY);
    expect(host.querySelector("button[type=submit]")!.textContent).toBe("Send invitation");
  });

  test("the field refuses an address the server would refuse", async () => {
    const host = await mount(<InviteMemberForm organizationId="org-a" />);
    const field = host.querySelector<HTMLInputElement>("#invite-email")!;
    await act(async () => type(field, "ana@empresa"));
    expect(field.validationMessage).toBe("Enter a full email address, like name@company.com.");
    await act(async () => type(field, "ana@empresa.com"));
    expect(field.validationMessage).toBe("");
  });
});
