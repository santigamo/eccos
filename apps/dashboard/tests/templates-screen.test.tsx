import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The templates page (`routes/templates.tsx`) — the per-row action column, and
 * the Preview door eccos-6je (docs/console-gaps-2026-09 §4) adds to it.
 *
 * WHAT THESE TESTS CAN REACH. The page is a TanStack Router route, so the
 * router hooks are stubbed with `mock.module` before the import — the same
 * approach as `tests/nav-setup.test.tsx` — and the loader data is fed
 * directly. React's `renderToStaticMarkup` needs no DOM. What is pinned here
 * is exactly what an operator's eye lands on in the grid: every named row
 * carries a ghost "Preview" control in its action cell, while a nameless row
 * holds the rhythm with the muted em-dash (data rule 5).
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

mock.module("@tanstack/react-router", () => ({
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
  test("every named row carries a Preview control, labelled with the row's name", () => {
    const html = render([ROW_WITH_COMPONENTS]);
    expect(html).toContain('aria-label="Preview order_update"');
    expect(html).toContain("Preview");
  });

  test("Preview renders beside Send test, and the row keeps the other actions", () => {
    // APPROVED + a phone: both doors read in order — preview first, the send
    // beside it.
    const html = render([ROW_WITH_COMPONENTS]);
    expect(html).toContain('aria-label="Preview order_update"');
    expect(html).toContain('aria-label="Send test message');
  });

  test("a nameless row holds the column with the muted em-dash, no Preview", () => {
    // Data rule 5: no dead controls. A row Meta returned without a name has no
    // identity to preview- or send by, so it shows neither button.
    const html = render([{ language: "en_US", status: "PENDING" }]);
    expect(html).not.toContain("Preview");
    expect(html).toContain('<span class="text-muted-foreground">');
  });

  test("the Preview control stays square and ghost — never a second primary", () => {
    const html = render([ROW_WITH_COMPONENTS]);
    // The ghost variant rests on `--ghost-fill-hover` and gains ink on hover —
    // the page's ONE primary is "New template" above the grid, carrying the
    // `--caustic` glow; Preview must not wear it (docs/DASHBOARD-DESIGN.md:
    // one primary per view). Square on every corner, like every control (law
    // 1).
    const previewStart = html.indexOf('aria-label="Preview order_update"');
    expect(previewStart).toBeGreaterThan(-1);
    const previewButton = html.slice(previewStart, html.indexOf(">Preview</button>", previewStart));
    expect(previewButton).toContain("rounded-none");
    expect(previewButton).toContain("hover:bg-(--ghost-fill-hover)");
    expect(previewButton).not.toContain("--caustic");
  });
});