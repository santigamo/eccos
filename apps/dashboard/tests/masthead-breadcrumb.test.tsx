import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AccountWabaResource } from "@eccos/gateway-contract";
import type { Membership } from "../src/auth/tenant";

/**
 * The masthead breadcrumb — **workspace · WABA** (eccos-c0d).
 *
 * The shell is derived from reui's `app-shell-7`, whose header carries a chain
 * of switcher dropdowns; the port took the sidebar and the user section and
 * left the breadcrumb behind. What that cost:
 *
 *   1. the workspace switcher landed in the SIDEBAR FOOTER, a second
 *      identity-shaped row stacked under the account row — the shell answering
 *      "who am I" and "where am I" in the same corner, in the same shape;
 *   2. the WABA crumb was a `Select` rendering the raw sixteen-digit WABA id in
 *      a monospace font, on the trigger and on every item, where the block puts
 *      a readable name.
 *
 * WHAT THESE TESTS CANNOT REACH. The dashboard's tests are `bun test` with
 * `renderToStaticMarkup` and no DOM. Both switchers' lists live inside a
 * base-ui dropdown, which renders through a PORTAL: with no document the menu's
 * items are absent from the static markup entirely, and there is no way to open
 * one without a DOM. So the assertions below cover the layers that are pure or
 * that do render:
 *
 *   - the derivations (`lib/workspaces.ts`, `lib/wabas.ts`), which decide what
 *     the operator is told;
 *   - `WorkspaceOption` / `WabaOption` — the rows the menus list, deliberately
 *     built out of plain elements with no menu context so the lists, the
 *     sub-labels and the active markings CAN be asserted here;
 *   - the two triggers, which are the part that answers "which workspace, which
 *     account" without opening anything.
 *
 * Not covered here: that clicking a workspace row calls `selectOrganization`
 * and reloads, that clicking a WABA row writes `wabaId` and clears `before` in
 * the search params, and the menus' own chrome — all need a DOM, and the WABA
 * navigation additionally needs a router. `MastheadBreadcrumb` itself is
 * router-bound and is not rendered here; its two crumbs are prop-driven for
 * exactly that reason and are rendered directly. The server-side half of a
 * workspace switch — that a non-member organization is refused — is covered end
 * to end against a real Better Auth in `tests/workspace-select.test.ts`.
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
const { activeWaba, hasWabaChoice, shortWabaId, wabaInitial, wabaLabel, wabaState } =
  await import("../src/lib/wabas");
const { CrumbSeparator, WabaOption, WabaSwitcher, WorkspaceOption, WorkspaceSwitcher } =
  await import("../src/components/blocks/app-shell-7/components/masthead-breadcrumb");

const ACME: Membership = { id: "org-a", name: "Acme", slug: "acme" };
const GLOBEX: Membership = { id: "org-b", name: "Globex", slug: "globex" };

/** A WABA as the gateway contract shapes it, with only the fields under test set. */
function makeWaba(
  wabaId: string,
  phoneNumbers: string[],
  overrides: Partial<AccountWabaResource> = {},
): AccountWabaResource {
  return {
    accountId: "acct-1",
    wabaId,
    callbackUrl: null,
    createdAt: 0,
    provisionedAt: null,
    status: "active",
    provisioningError: null,
    phones: phoneNumbers.map((displayPhoneNumber, index) => ({
      phoneNumberId: `${wabaId}-${index}`,
      displayPhoneNumber,
    })),
    coexistence: {
      onboardingType: "standard",
      verifiedOnboardingType: null,
      status: "not_applicable",
      deadlineAt: null,
      contactsStartedAt: null,
      contactsRequestId: null,
      historyStartedAt: null,
      historyRequestId: null,
      error: null,
    },
    ...overrides,
  };
}

const SALES = makeWaba("102938475610111", ["+34 600 111 222"]);
const SUPPORT = makeWaba("102938475699999", ["+34 600 333 444"]);

function renderWorkspaceCrumb(
  workspaces: Membership[],
  activeWorkspaceId: string | null,
): string {
  return renderToStaticMarkup(
    <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />,
  );
}

function renderWabaCrumb(wabas: AccountWabaResource[], selectedWabaId: string | null): string {
  return renderToStaticMarkup(
    <WabaSwitcher wabas={wabas} selectedWabaId={selectedWabaId} onSelect={() => {}} />,
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

describe("wabaLabel: the crumb leads with what a person recognises", () => {
  test("the business phone number, not the sixteen-digit id", () => {
    expect(wabaLabel(SALES)).toBe("+34 600 111 222");
    expect(wabaLabel(SALES)).not.toContain(SALES.wabaId);
  });

  test("the first number when the account has several", () => {
    expect(wabaLabel(makeWaba("1", ["+34 600 111 222", "+34 600 999 888"]))).toBe(
      "+34 600 111 222",
    );
  });

  test("a blank display number is not a name", () => {
    // Embedded Signup can hand back a phone record with nothing in it.
    expect(wabaLabel(makeWaba("102938475610111", ["   "]))).toBe("1029…0111");
  });

  test("a WABA with no number yet falls back to the shortened id", () => {
    // The only case where the console has genuinely nothing better to show.
    expect(wabaLabel(makeWaba("102938475610111", []))).toBe("1029…0111");
  });

  test("shortWabaId keeps head AND tail — two WABAs differ in their last digits", () => {
    expect(shortWabaId("102938475610111")).toBe("1029…0111");
    expect(shortWabaId("102938475699999")).toBe("1029…9999");
    expect(shortWabaId("102938475610111")).not.toBe(shortWabaId("102938475699999"));
    // Short enough to show whole: shown whole.
    expect(shortWabaId("1029384")).toBe("1029384");
  });

  test("the monogram is the label's first character — the + of E.164", () => {
    expect(wabaInitial(SALES)).toBe("+");
    expect(wabaInitial(makeWaba("102938475610111", []))).toBe("1");
  });
});

describe("wabaState: the sub-label is state, in the status tag's own vocabulary", () => {
  test("a provisioned, non-coexistence account is plain active", () => {
    expect(wabaState(SALES)).toBe("active");
  });

  test("provisioning outranks everything — a pending WABA cannot even be scoped to", () => {
    expect(wabaState(makeWaba("1", ["+1"], { status: "pending" }))).toBe("pending");
    expect(wabaState(makeWaba("1", ["+1"], { status: "failed" }))).toBe("failed");
  });

  test("not_coexistence surfaces on an otherwise active account", () => {
    const waba = makeWaba("1", ["+1"], {
      coexistence: { ...SALES.coexistence, status: "not_coexistence" },
    });
    expect(wabaState(waba)).toBe("not_coexistence");
  });

  test("coexistence states that are not the operator's problem stay quiet", () => {
    for (const status of ["not_applicable", "pending", "initiated"] as const) {
      const waba = makeWaba("1", ["+1"], {
        coexistence: { ...SALES.coexistence, status },
      });
      expect(wabaState(waba)).toBe("active");
    }
  });
});

describe("activeWaba / hasWabaChoice", () => {
  test("honours the selection while it is still one of the account's WABAs", () => {
    expect(activeWaba([SALES, SUPPORT], SUPPORT.wabaId)).toEqual(SUPPORT);
  });

  test("a stale ?wabaId= for an account this operator does not own names nothing", () => {
    expect(activeWaba([SALES], "999")).toBeNull();
  });

  test("a sole WABA is defaulted to, as the server's scope resolution does", () => {
    expect(activeWaba([SALES], null)).toEqual(SALES);
    expect(activeWaba([SALES, SUPPORT], null)).toBeNull();
  });

  test("one WABA is not a choice", () => {
    expect(hasWabaChoice([])).toBe(false);
    expect(hasWabaChoice([SALES])).toBe(false);
    expect(hasWabaChoice([SALES, SUPPORT])).toBe(true);
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

describe("WabaOption: the account list, its state, and its active marking", () => {
  test("lists every WABA by number, with the id kept as the machine-voice sub-line", () => {
    const html = renderToStaticMarkup(
      [SALES, SUPPORT].map((waba) => (
        <WabaOption key={waba.wabaId} waba={waba} active={waba.wabaId === SALES.wabaId} />
      )),
    );
    expect(html).toContain("+34 600 111 222");
    expect(html).toContain("+34 600 333 444");
    // The id is still reachable — it just stopped being the only thing offered.
    expect(html).toContain(SALES.wabaId);
    expect(html).toContain(SUPPORT.wabaId);
    expect(html.match(/data-active="true"/g)?.length).toBe(1);
    expect(html.match(/Current WhatsApp Business account/g)?.length).toBe(1);
  });

  test("the active row carries the marking, an inactive row carries none", () => {
    const active = renderToStaticMarkup(<WabaOption waba={SALES} active />);
    expect(active).toContain(`data-waba="${SALES.wabaId}"`);
    expect(active).toContain('data-active="true"');
    expect(active).toContain("Current WhatsApp Business account");

    const inactive = renderToStaticMarkup(<WabaOption waba={SUPPORT} active={false} />);
    expect(inactive).toContain(`data-waba="${SUPPORT.wabaId}"`);
    expect(inactive).not.toContain("data-active");
    expect(inactive).not.toContain("Current WhatsApp Business account");
  });

  test("every row carries its state in the console's status tag, not a new idiom", () => {
    // The menu is where states are compared, so every row is tagged there.
    expect(renderToStaticMarkup(<WabaOption waba={SALES} active />)).toContain(">active<");

    const pending = renderToStaticMarkup(
      <WabaOption waba={makeWaba("1", ["+1"], { status: "pending" })} active={false} />,
    );
    expect(pending).toContain(">pending<");
    // The existing tag anatomy: square, 1px edge, machine voice, amber ink.
    expect(pending).toContain("text-[#f0a020]");

    const coexistence = renderToStaticMarkup(
      <WabaOption
        waba={makeWaba("1", ["+1"], {
          coexistence: { ...SALES.coexistence, status: "not_coexistence" },
        })}
        active={false}
      />,
    );
    expect(coexistence).toContain(">not_coexistence<");
  });

  test("the row is square and reuses the monogram, never a circular avatar", () => {
    const html = renderToStaticMarkup(<WabaOption waba={SALES} active={false} />);
    expect(html).toContain(">+</span>");
    expect(html).not.toContain("rounded-full");
    expect(html).not.toContain("font-pixel");
  });
});

describe("the workspace crumb: which workspace am I in, without opening anything", () => {
  test("names the active workspace on the trigger itself", () => {
    const html = renderWorkspaceCrumb([ACME, GLOBEX], "org-a");
    expect(html).toContain("Acme");
    expect(html).toContain('aria-label="Workspace: Acme"');
    expect(html).toContain(">A</span>");
  });

  test("a lone workspace is still named — no ambiguity, no clutter", () => {
    // Nothing stored, one membership: the crumb shows what the server would
    // resolve, and the switch list has nothing to list (only "New workspace",
    // which lives inside the same menu, as the block does it).
    const html = renderWorkspaceCrumb([ACME], null);
    expect(html).toContain("Acme");
    expect(html).toContain('aria-label="Workspace: Acme"');
    expect(hasWorkspaceChoice([ACME])).toBe(false);
  });

  test("an unmade choice says so rather than guessing", () => {
    const html = renderWorkspaceCrumb([ACME, GLOBEX], null);
    expect(html).toContain("Not selected");
    expect(html).toContain('aria-label="Choose a workspace"');
  });

  test("square, and Inter — the pixel face is a brand accent, not a control", () => {
    const html = renderWorkspaceCrumb([ACME], "org-a");
    expect(html).not.toContain("rounded-full");
    expect(html).not.toContain("font-pixel");
    // The console's interaction law: the hover edge turns green.
    expect(html).toContain("hover:border-(--ghost-edge-hover)");
  });
});

describe("the WABA crumb: a name where the raw id used to be", () => {
  test("names the selected account by its number, with no monospace id on the bar", () => {
    const html = renderWabaCrumb([SALES, SUPPORT], SALES.wabaId);
    expect(html).toContain("+34 600 111 222");
    expect(html).toContain('aria-label="WhatsApp Business account: +34 600 111 222"');
    // The defect this replaced: the id, in a monospace font, on the trigger.
    expect(html).not.toContain(SALES.wabaId);
    expect(html).not.toContain("font-mono");
  });

  test("several accounts make it a switcher", () => {
    const html = renderWabaCrumb([SALES, SUPPORT], SUPPORT.wabaId);
    expect(html).toContain("<button");
    expect(html).toContain("+34 600 333 444");
  });

  test("one account is named but is not a chooser with one item in it", () => {
    const html = renderWabaCrumb([SALES], SALES.wabaId);
    expect(html).toContain("+34 600 111 222");
    expect(html).not.toContain("<button");
    expect(html).toContain(`data-waba="${SALES.wabaId}"`);
  });

  test("a healthy scope is quiet; a meaningful state is not", () => {
    // Data rule 1: colour only for state that means something. The always-on
    // crumb stays plain while the account is fine...
    expect(renderWabaCrumb([SALES], SALES.wabaId)).not.toContain(">active<");
    // ...and says so when it is not. `not_coexistence` is the state that can
    // reach the SELECTED WABA: the server refuses to scope to a pending or
    // failed one at all.
    const odd = makeWaba("102938475610111", ["+34 600 111 222"], {
      coexistence: { ...SALES.coexistence, status: "not_coexistence" },
    });
    expect(renderWabaCrumb([odd], odd.wabaId)).toContain(">not_coexistence<");
  });

  test("a stale selection names nothing rather than the wrong account", () => {
    expect(renderWabaCrumb([SALES, SUPPORT], "999")).toBe("");
  });

  test("Inter, square, and the green hover edge — same crumb as the first", () => {
    const html = renderWabaCrumb([SALES, SUPPORT], SALES.wabaId);
    expect(html).not.toContain("font-pixel");
    expect(html).not.toContain("rounded-full");
    expect(html).toContain("hover:border-(--ghost-edge-hover)");
  });
});

describe("the separator is the project's idiom", () => {
  test("a middle dot, never a slash", () => {
    const html = renderToStaticMarkup(<CrumbSeparator />);
    expect(html).toContain(">·</li>");
    expect(html).not.toContain(">/</li>");
    expect(html).toContain('aria-hidden="true"');
  });
});
