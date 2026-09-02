import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Membership } from "../src/auth/tenant";

/**
 * The shell's workspace control (eccos-c0d).
 *
 * The defect: the console had no workspace control at all. Switching existed
 * only as a failure state — a member of two organizations chose once, on their
 * first refused request, and was pinned there for the session — and creating a
 * second workspace was built but unreachable, because `/onboarding` is
 * `createOrganization`'s only caller and the root loader ejects anyone who
 * already has a workspace from that route.
 *
 * WHAT THESE TESTS CANNOT REACH. The dashboard's tests are `bun test` with
 * `renderToStaticMarkup` and no DOM. The switcher's list lives inside a base-ui
 * dropdown, which renders through a PORTAL: with no document, the menu's items
 * are absent from the static markup entirely (verified — the trigger renders,
 * the popup does not), and there is no way to open it without a DOM. So the
 * assertions below cover the three layers that do render or are pure:
 *
 *   1. the active-workspace derivation (`lib/workspaces.ts`), which is the
 *      logic that decides what the operator is told;
 *   2. `WorkspaceOption` — the row the menu lists, deliberately built out of
 *      plain elements with no menu context so the membership list and the
 *      active marking CAN be asserted here;
 *   3. the trigger, which is the part that answers "which workspace am I in"
 *      without opening anything, and which does render statically.
 *
 * Not covered here: that clicking a row calls `selectOrganization` and reloads
 * (needs a DOM), and the menu's own chrome. The server-side half of a switch —
 * that a non-member organization is refused — is covered end to end against a
 * real Better Auth in `tests/workspace-select.test.ts`.
 */

mock.module("cloudflare:workers", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
}));

mock.module("@tanstack/react-start", () => {
  const api = {
    validator: (_v: unknown) => api,
    handler: (fn: (arg?: unknown) => unknown) => (arg?: unknown) =>
      fn(arg && typeof arg === "object" && "data" in arg ? arg : { data: arg }),
  };
  return { createServerFn: (_opts?: unknown) => api };
});

mock.module("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/", { headers: new Headers() }),
}));

const { activeWorkspace, hasWorkspaceChoice, workspaceInitial, workspaceLabel } =
  await import("../src/lib/workspaces");
const { WorkspaceOption, WorkspaceSwitcher } = await import(
  "../src/components/blocks/app-shell-7/components/nav-workspace"
);
const { SidebarProvider } = await import("../src/components/ui/sidebar");

const ACME: Membership = { id: "org-a", name: "Acme", slug: "acme" };
const GLOBEX: Membership = { id: "org-b", name: "Globex", slug: "globex" };

function renderSwitcher(workspaces: Membership[], activeWorkspaceId: string | null): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
    </SidebarProvider>,
  );
}

describe("activeWorkspace: the console never names a scope the server would refuse", () => {
  test("honours the stored active organization", () => {
    expect(activeWorkspace([ACME, GLOBEX], "org-b")).toEqual(GLOBEX);
  });

  test("a sole membership is defaulted to, as requirePermission does", () => {
    expect(activeWorkspace([ACME], null)).toEqual(ACME);
  });

  test("several memberships with nothing stored has no answer yet", () => {
    // The server's `select-organization` state: the console must not guess.
    expect(activeWorkspace([ACME, GLOBEX], null)).toBeNull();
  });

  test("a stored organization the user no longer belongs to resolves to null", () => {
    // Access revoked mid-session: the server would answer `not-a-member`, so
    // the shell must not keep displaying it as the current workspace.
    expect(activeWorkspace([ACME], "org-gone")).toBeNull();
  });

  test("no memberships at all", () => {
    expect(activeWorkspace([], null)).toBeNull();
    expect(activeWorkspace([], "org-a")).toBeNull();
  });
});

describe("workspace labels", () => {
  test("falls back name → slug → id", () => {
    expect(workspaceLabel(ACME)).toBe("Acme");
    expect(workspaceLabel({ id: "org-c", name: "", slug: "initech" })).toBe("initech");
    expect(workspaceLabel({ id: "org-c", name: "", slug: "" })).toBe("org-c");
  });

  test("the monogram is the label's first letter, uppercased", () => {
    expect(workspaceInitial(ACME)).toBe("A");
    expect(workspaceInitial({ id: "org-c", name: "", slug: "initech" })).toBe("I");
  });
});

describe("hasWorkspaceChoice: one workspace is not a choice", () => {
  test("no list for zero or one membership, a list for two", () => {
    expect(hasWorkspaceChoice([])).toBe(false);
    expect(hasWorkspaceChoice([ACME])).toBe(false);
    expect(hasWorkspaceChoice([ACME, GLOBEX])).toBe(true);
  });
});

describe("WorkspaceOption: the membership list and its active marking", () => {
  test("lists every workspace with its name and slug", () => {
    const html = renderToStaticMarkup(
      [ACME, GLOBEX].map((workspace) => (
        <WorkspaceOption
          key={workspace.id}
          workspace={workspace}
          active={workspace.id === "org-a"}
        />
      )),
    );
    expect(html).toContain("Acme");
    expect(html).toContain("Globex");
    expect(html).toContain("acme");
    expect(html).toContain("globex");
    // Exactly one row is marked current — never zero, never both.
    expect(html.match(/data-active="true"/g)?.length).toBe(1);
    expect(html.match(/Current workspace/g)?.length).toBe(1);
  });

  test("the active row carries the marking, an inactive row carries none", () => {
    const active = renderToStaticMarkup(<WorkspaceOption workspace={ACME} active />);
    expect(active).toContain('data-workspace="org-a"');
    expect(active).toContain('data-active="true"');
    expect(active).toContain("Current workspace");

    const inactive = renderToStaticMarkup(<WorkspaceOption workspace={GLOBEX} active={false} />);
    expect(inactive).toContain('data-workspace="org-b"');
    expect(inactive).not.toContain("data-active");
    expect(inactive).not.toContain("Current workspace");
  });

  test("the monogram is the console's square initial, not a second avatar idiom", () => {
    const html = renderToStaticMarkup(<WorkspaceOption workspace={ACME} active={false} />);
    expect(html).toContain(">A</span>");
    // Zero radius everywhere (docs/DASHBOARD-DESIGN.md law 1).
    expect(html).not.toContain("rounded-full");
  });
});

describe("WorkspaceSwitcher: which workspace am I in, without opening anything", () => {
  test("names the active workspace on the trigger itself", () => {
    const html = renderSwitcher([ACME, GLOBEX], "org-a");
    expect(html).toContain("Acme");
    expect(html).toContain('aria-label="Workspace: Acme"');
    // The machine-voice kicker that tells this row apart from the identity row.
    expect(html).toContain(">Workspace</span>");
    expect(html).toContain(">Acme</span>");
  });

  test("a lone workspace is still named — no ambiguity, no clutter", () => {
    // Nothing stored, one membership: the shell shows what the server would
    // resolve, and the switch list has nothing to list.
    const html = renderSwitcher([ACME], null);
    expect(html).toContain("Acme");
    expect(html).toContain('aria-label="Workspace: Acme"');
    expect(hasWorkspaceChoice([ACME])).toBe(false);
  });

  test("an unmade choice says so rather than guessing", () => {
    const html = renderSwitcher([ACME, GLOBEX], null);
    expect(html).toContain("Not selected");
    expect(html).toContain('aria-label="Choose a workspace"');
  });

  test("the trigger is square and keeps the console's functional register", () => {
    const html = renderSwitcher([ACME], "org-a");
    expect(html).not.toContain("rounded-full");
    // Inter uppercase 11px tracking-wider — the functional voice, never pixel.
    expect(html).toContain("text-[11px] font-medium tracking-wider");
    expect(html).not.toContain("font-pixel");
  });
});
