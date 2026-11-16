import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/** The Workspace panel's rename row, driven in a DOM through its `rename` seam. */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { redirect } = await import("@tanstack/react-router");
const { WorkspacePanel } = await import("../src/components/dashboard/workspace-panel");

type Rename = NonNullable<Parameters<typeof WorkspacePanel>[0]["rename"]>;
const workspace = { id: "org-a", name: "Citta", role: "owner" };

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

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

async function renameTo(name: string, rename: (data: { organizationId: string; name: string }) => unknown) {
  const sent: Array<{ organizationId: string; name: string }> = [];
  let renamed = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const seam = (async ({ data }: { data: { organizationId: string; name: string } }) => {
    sent.push(data);
    return rename(data);
  }) as unknown as Rename;
  const render = (serverName: string) =>
    act(async () =>
      root.render(
        <WorkspacePanel
          accountId="acc_1"
          workspace={{ ...workspace, name: serverName }}
          canRename
          rename={seam}
          onRenamed={() => renamed++}
        />,
      ),
    );
  await render(workspace.name);
  unmount = () => root.unmount();
  await act(async () => button("Rename").click());
  const input = document.getElementById("workspace-name") as HTMLInputElement;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  return { sent, renamed: () => renamed, render };
}

describe("WorkspacePanel rename", () => {
  test("sends the workspace the page shows, and shows the saved name at once", async () => {
    const { sent, renamed } = await renameTo("Citta Madrid", (data) => ({ ok: true, data: { name: data.name } }));
    expect(sent).toEqual([{ organizationId: "org-a", name: "Citta Madrid" }]);
    expect(document.body.textContent).toContain("Citta Madrid");
    expect(renamed()).toBe(1);
  });

  test("the saved name gives way once the server's name changes, even back to the old one", async () => {
    const { render } = await renameTo("Citta Madrid", (data) => ({ ok: true, data: { name: data.name } }));
    const shown = () => document.querySelector("dd span")?.textContent;
    expect(shown()).toBe("Citta Madrid");
    await render("Citta Madrid"); // the reloaded root catches up
    await render("Citta"); // someone else renames it back
    expect(shown()).toBe("Citta");
  });

  test("a session that moved to another workspace reads as a refusal, not a red error", async () => {
    await renameTo("Other", () => ({ ok: false, kind: "forbidden", reason: "workspace-changed", error: "moved" }));
    expect(document.body.textContent).toContain("Workspace changed");
    expect(document.body.textContent).toContain("You switched workspace in another tab. Reload this page.");
    expect(document.body.innerHTML).not.toContain("text-destructive-foreground");
  });

  test("the name input is not offered to a password manager", async () => {
    await renameTo("x", () => new Promise(() => {}));
    const input = document.getElementById("workspace-name") as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.hasAttribute("data-1p-ignore")).toBe(true);
  });

  test("a refusal reads through failureCopy", async () => {
    await renameTo("Other", () => ({ ok: false, kind: "forbidden", reason: "select-organization", error: "pick" }));
    expect(document.body.textContent).toContain("You belong to more than one workspace");
  });

  test("an expired session follows the sign-in redirect instead of showing an error", async () => {
    const assigned: string[] = [];
    const original = window.location.assign;
    Object.defineProperty(window.location, "assign", { configurable: true, value: (href: string) => assigned.push(href) });
    try {
      await renameTo("Later", () => {
        throw redirect({ href: "/signin?redirect=%2Fsettings" });
      });
      expect(assigned).toEqual(["/signin?redirect=%2Fsettings"]);
      expect(document.body.textContent).not.toContain("Could not rename");
    } finally {
      Object.defineProperty(window.location, "assign", { configurable: true, value: original });
    }
  });
});
