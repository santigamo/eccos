/**
 * The OAuth pages in a real DOM (happy-dom): what the consent page shows and
 * sends, the workspace step's two shapes, and the sign-in and sign-up links
 * that must carry a pending authorization across (task 1.3).
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

/** What the pages sent to the auth server. Installed before the auth client captures `fetch`. */
let sent: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  sent.push({ url: request.url, body: (await request.json().catch(() => ({}))) as Record<string, unknown> });
  return Response.json({ redirect: true, url: "https://agent.example.com/callback?code=c" });
}) as typeof fetch;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { OAuthConsentView } = await import("../src/components/blocks/auth-13/oauth-consent-view");
const { OAuthWorkspaceView } = await import("../src/components/blocks/auth-13/oauth-workspace-view");
const { SignInView } = await import("../src/components/blocks/auth-13/signin-view");
const { SignUpView } = await import("../src/components/blocks/auth-13/signup-view");

const SIGNED = "client_id=agent-1&scope=eccos%3Aview+eccos%3Asend+eccos%3Aadminister+offline_access&ba_param=client_id&ba_param=scope&sig=abc";

let unmount: (() => void) | null = null;
let assigned: string[] = [];

beforeEach(() => {
  sent = [];
  assigned = [];
  window.location.assign = ((url: string) => void assigned.push(url)) as typeof window.location.assign;
});

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  document.body.innerHTML = "";
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

async function mount(path: string, node: ReactNode): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmount = () => root.unmount();
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function consentView() {
  return (
    <OAuthConsentView
      clientName="Claude"
      redirectHost="claude.ai"
      workspaceName="Shop"
      scope="eccos:view eccos:send eccos:administer offline_access"
    />
  );
}

describe("the consent page", () => {
  test("shows the client's name, its redirect host, the workspace and each scope in plain words", async () => {
    const host = await mount(`/oauth/consent?${SIGNED}`, consentView());
    const text = host.textContent ?? "";
    expect(text).toContain("Claude");
    expect(text).toContain("claude.ai");
    expect(text).toContain("Shop");
    expect(text).toContain("model provider");
    expect(text).toContain("Meta bills");
    expect(text).toContain("billing");
    expect(text).toContain("inline");
    expect(host.querySelectorAll('[role="checkbox"]').length).toBe(3);
  });

  test("view's copy says what reaches the model provider and leaves billing to administer", async () => {
    const host = await mount(`/oauth/consent?${SIGNED}`, consentView());
    const rows = [...host.querySelectorAll("[data-scope]")];
    const copy = (scope: string) => rows.find((r) => r.getAttribute("data-scope") === scope)?.textContent ?? "";
    expect(copy("eccos:view")).toContain("phone numbers");
    expect(copy("eccos:view")).not.toContain("billing");
    expect(copy("eccos:administer")).toContain("API key");
    expect(copy("eccos:administer")).toContain("checkout");
    expect(copy("eccos:send")).toContain("real messages");
  });

  test("accept sends only the ticked scopes, with the signed query", async () => {
    const host = await mount(`/oauth/consent?${SIGNED}`, consentView());
    const send = host.querySelector<HTMLElement>('[data-scope="eccos:send"] [role="checkbox"]')!;
    await act(async () => send.click());
    await act(async () => button(host, "Allow").click());
    const call = sent.find((c) => c.url.endsWith("/api/auth/oauth2/consent"))!;
    expect(call.body.accept).toBe(true);
    expect(String(call.body.scope).split(" ").sort()).toEqual(["eccos:administer", "eccos:view", "offline_access"]);
    expect(call.body.oauth_query).toContain("sig=abc");
    expect(assigned).toEqual(["https://agent.example.com/callback?code=c"]);
  });

  test("nothing ticked: Allow is disabled, Deny still answers the client", async () => {
    const host = await mount(`/oauth/consent?${SIGNED}`, consentView());
    for (const box of host.querySelectorAll<HTMLElement>('[role="checkbox"]')) await act(async () => box.click());
    expect(button(host, "Allow").disabled).toBe(true);
    await act(async () => button(host, "Deny").click());
    const call = sent.find((c) => c.url.endsWith("/api/auth/oauth2/consent"))!;
    expect(call.body.accept).toBe(false);
  });
});

describe("the workspace step", () => {
  test("lists every workspace the user belongs to, to pick one", async () => {
    const host = await mount(
      `/oauth/workspace?${SIGNED}`,
      <OAuthWorkspaceView workspaces={[{ id: "o1", name: "First" }, { id: "o2", name: "Second" }]} />,
    );
    expect(button(host, "First")).toBeTruthy();
    expect(button(host, "Second")).toBeTruthy();
    expect(host.querySelector("input")).toBeNull();
  });

  test("a user with none names their first workspace", async () => {
    const host = await mount(`/oauth/workspace?${SIGNED}`, <OAuthWorkspaceView workspaces={[]} />);
    expect(host.textContent).toContain("Workspace name");
    expect(host.querySelector("#onboarding-name")).not.toBeNull();
  });
});

describe("switching between sign-in and sign-up keeps the authorization", () => {
  test("sign-in's Create your account link carries the signed query", async () => {
    const host = await mount(`/signin?${SIGNED}`, <SignInView redirectTo="/" searchError={null} />);
    const link = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("/signup"))!;
    const query = new URL(link.getAttribute("href")!, "http://localhost:3000").searchParams;
    expect(query.get("sig")).toBe("abc");
    expect(query.get("client_id")).toBe("agent-1");
  });

  test("sign-up's Sign in link carries the signed query", async () => {
    const host = await mount(`/signup?${SIGNED}`, <SignUpView />);
    const link = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("/signin"))!;
    const query = new URL(link.getAttribute("href")!, "http://localhost:3000").searchParams;
    expect(query.get("sig")).toBe("abc");
    expect(query.getAll("ba_param")).toEqual(["client_id", "scope"]);
  });
});
