import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The templates page (`routes/templates.tsx`) — the per-row action column, and
 * the Preview door eccos-6je (docs/console-gaps-2026-09 §4) adds to it.
 *
 * WHAT MOVED (eccos-pxr). Preview is no longer a button in the action column:
 * the row opens it, and the template NAME is the focusable, visibly-marked
 * control that says so. Send test and Delete moved into a kebab menu. Base UI
 * renders a closed menu as nothing at all, so what the menu HOLDS cannot be
 * reached by a static render — the tests below pin the trigger, and the
 * absence of inline buttons is what proves the two acts went inside it.
 *
 * WHAT THESE TESTS CAN REACH. The page is a TanStack Router route, so the
 * router hooks are stubbed with `mock.module` before the import — the same
 * approach as `tests/nav-setup.test.tsx` — and the loader data is fed
 * directly. React's `renderToStaticMarkup` needs no DOM. What is pinned here
 * is exactly what an operator's eye lands on in the grid: a named row is a
 * door with a kebab at its end, while a nameless row holds the rhythm with the
 * muted em-dash (data rule 5).
 *
 * THE SHEET ITSELF IS NOT OPENED HERE. Opening it — and reading the row's
 * `components` into the header/body/footer/buttons — is a click-driven
 * transition no static render can reach; the sheet's own rendering contract
 * lives in `tests/template-preview-sheet.test.tsx`, which renders
 * `TemplatePreview` directly with the row's components fed in.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

/** Fixtures the route's hooks will read on the next render. */
let loaderData: unknown;
let searchParams: { wabaId?: string } = {};
let rootData: unknown;

// SPREAD, not replaced — see the same note in tests/nav-setup.test.tsx. The
// first stub for a specifier fixes which keys exist for the whole process, so
// a partial one strips exports the next file needs.
const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  createFileRoute: () => (opts: unknown) => ({
    ...(opts as object),
    useLoaderData: () => loaderData,
    useSearch: () => searchParams,
  }),
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
  useLoaderData: () => rootData,
  useSearch: () => searchParams,
  useRouter: () => ({ invalidate: () => {} }),
}));

const { Route } = await import("../src/routes/templates");

/** A templates result as `listTemplates` resolves it, with a `components` row. */
function loaderFixture(rows: unknown[]): unknown {
  return { ok: true, data: { ok: true, data: { data: rows } } };
}

/** Ready scope with a phone, so "Send test" is offered on approved rows. */
const readyScope = {
  accountId: "account-a",
  selectedWabaId: "waba-a",
  resources: {
    account: {
      accountId: "account-a",
      name: "Account A",
      createdAt: 1,
    },
    keys: [],
    wabas: [
      {
        accountId: "account-a",
        wabaId: "waba-a",
        callbackUrl: null,
        createdAt: 1,
        provisionedAt: 2,
        status: "active",
        provisioningError: null,
        phones: [
          {
            phoneNumberId: "phone-a",
            displayPhoneNumber: "+34 600 000 000",
          },
        ],
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
      },
    ],
    phones: [
      {
        wabaId: "waba-a",
        phoneNumberId: "phone-a",
        displayPhoneNumber: "+34 600 000 000",
      },
    ],
  },
};

function render(rows: unknown[]): string {
  loaderData = loaderFixture(rows);
  searchParams = { wabaId: "waba-a" };
  rootData = { ok: true, data: readyState };
  return renderToStaticMarkup(<Route.component />);
}

/** Root loader state: the account is `ready` with one active number. */
const readyState = {
  stage: "ready",
  status: {
    name: "gateway",
    version: "1.0.0",
    health: "healthy",
    connection: {
      wabaId: "waba-a",
      phoneNumberId: "phone-a",
      displayPhone: "+34 600 000 000",
      connectedAt: "2026-09-01T10:00:00.000Z",
    },
    counts: { inbound: 0, outbound: {}, deliveries: {} },
  },
  scope: readyScope,
};

/** The row Meta returns for an approved template Citta actually uses. */
const ROW_WITH_COMPONENTS = {
  name: "order_update",
  language: "es_ES",
  status: "APPROVED",
  id: "123",
  components: [
    { type: "HEADER", format: "TEXT", text: "Your order" },
    { type: "BODY", text: "Hi {{1}}, your order {{2}} shipped." },
    { type: "FOOTER", text: "Powered by Eccos" },
    {
      type: "BUTTONS",
      buttons: [{ type: "URL", text: "Track", url: "https://e.com/status" }],
    },
  ],
};

describe("TemplatesPage row actions", () => {
  test("the name is the door into the preview: focusable, labelled, and marked", () => {
    // Preview moved off the action column and onto the ROW. The row click is
    // the wide target; this button is the one a keyboard can reach and the one
    // that says on screen that the row opens something — without it the
    // preview would exist only for a pointer that happened to try, which is
    // the affordance-on-hover the design contract rules out.
    const html = render([ROW_WITH_COMPONENTS]);
    expect(html).toContain('aria-label="Preview order_update"');
    expect(html).toContain(">order_update</button>");
    // The console's existing door anatomy (`COUNT_LINK` in src/ui.tsx): quiet
    // at rest, underlined and green under the pointer.
    expect(html).toContain("hover:underline");
    expect(html).toContain("hover:text-primary");
  });

  test("the row itself is the wide target", () => {
    const html = render([ROW_WITH_COMPONENTS]);
    // The grid only paints this once a caller passes `onRowClick`, so it is
    // the observable proof that the row opens the preview too.
    const row = html.slice(html.indexOf('data-row-id="123"'));
    expect(row.slice(0, row.indexOf(">"))).toContain("cursor-pointer");
  });

  test("Send test and Delete are behind one kebab, not inline on the row", () => {
    // Both of these WRITE — one sends a real WhatsApp message, the other
    // deletes a template at Meta — so they cost a deliberate second click and
    // stop competing with the row's own name for width.
    const html = render([ROW_WITH_COMPONENTS]);
    expect(html).toContain('aria-label="Actions for order_update (es_ES)"');
    expect(html).toContain('aria-haspopup="menu"');
    // The items live inside a closed Base UI menu, which is portalled and
    // renders nothing until it opens — so their absence here IS the assertion
    // that neither is sitting inline in the cell.
    expect(html).not.toContain("Send test");
    expect(html).not.toContain("Delete");
  });

  test("the action column carries no visible header, only a labelled one", () => {
    // Every other header on this grid names what is IN the column; a word over
    // a single kebab would name the column instead of the act.
    const html = render([ROW_WITH_COMPONENTS]);
    expect(html).toContain('<span class="sr-only">Actions</span>');
  });

  test("a nameless row holds both columns with the muted em-dash", () => {
    // Data rule 5: no dead controls. A row Meta returned without a name has no
    // identity to preview by, and no id to delete by, so it offers neither a
    // door nor a menu.
    const html = render([{ language: "en_US", status: "PENDING" }]);
    expect(html).not.toContain("aria-label=\"Preview");
    expect(html).not.toContain("aria-label=\"Actions for");
    expect(html).toContain('<span class="text-muted-foreground">');
  });

  test("the kebab stays square and ghost — never a second primary", () => {
    // The page's ONE primary is "New template" above the grid, carrying the
    // `--caustic` glow. Square on every corner, like every control (law 1).
    const html = render([ROW_WITH_COMPONENTS]);
    const start = html.indexOf('aria-label="Actions for order_update');
    expect(start).toBeGreaterThan(-1);
    const trigger = html.slice(start, html.indexOf("</button>", start));
    expect(trigger).toContain("rounded-none");
    expect(trigger).toContain("hover:bg-(--ghost-fill-hover)");
    expect(trigger).not.toContain("--caustic");
  });
});
