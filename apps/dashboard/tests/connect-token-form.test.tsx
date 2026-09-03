import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering contract for the pasted-token panel (eccos-up9),
 * `components/dashboard/connect-token.tsx`.
 *
 * Importing the component pulls in `src/server/gateway.ts`, which imports
 * `cloudflare:workers` and `@tanstack/react-start` — mocked here BEFORE the
 * import, the recipe `tests/send-test-form.test.tsx` documents.
 *
 * What is pinned: the design contract (docs/DASHBOARD-DESIGN.md) — square
 * corners, the Inter-uppercase-11px functional register, a ghost submit rather
 * than a second primary — and the HONESTY MITIGATION, which is the whole reason
 * this form is allowed to be visible to a customer it cannot serve. If the
 * precondition sentence ever disappears, the surface becomes a lie and this
 * test is what says so.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { TokenConnectPanel, TokenCandidateList } = await import(
  "../src/components/dashboard/connect-token"
);

const html = renderToStaticMarkup(<TokenConnectPanel />);

describe("TokenConnectPanel", () => {
  test("states its precondition and the flow that serves everyone else", () => {
    // INVARIANT: the mitigation for a form that cannot work for every operator
    // is that it SAYS SO before they submit, and names Embedded Signup as the
    // path that does work. Hiding the form was not an option — workability is a
    // property of the token, not of the deployment.
    expect(html).toContain("own Meta app");
    expect(html).toContain("Connect with Meta");
    // And the two costs, in the functional register.
    expect(html).toContain("Test tokens expire in about");
  });

  test("masks the credential and asks the browser not to keep it", () => {
    // INVARIANT: a live credential typed on a screen that is, by this panel's
    // own reason for existing, likely being recorded.
    expect(html).toContain('type="password"');
    // Case-insensitive: the Base UI input serializes the prop name as written,
    // and HTML attribute names are case-insensitive.
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toContain('id="connect-token"');
  });

  test("keeps the console's two laws: square corners, machine-voice labels", () => {
    // INVARIANT: nothing rounds a corner, and a form label is Inter 11px
    // uppercase with wide tracking — never stock shadcn's register.
    // `rounded-(--frame-radius)` and friends resolve to 0 (app.css pins every
    // `--radius-*` to 0), so token-based utilities are square already and are
    // excluded — the same recipe as `numbers-screen.test.tsx`.
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
    expect(html).toContain("rounded-none");
    expect(html).toContain("text-[11px] font-medium tracking-wider text-muted-foreground uppercase");
  });

  test("submits with the ghost control, not a second primary", () => {
    // INVARIANT: one primary per view, and Settings already spends it on the
    // forwarding target's Save. The ghost anatomy is the `--ghost-fill` + a
    // `--line-strong` edge that greens on hover.
    expect(html).toContain("Attach number");
    expect(html).toContain("border-(--line-strong)");
    expect(html).toContain("bg-(--ghost-fill)");
    // The primary's brand glow belongs to Save; it must not appear here.
    expect(html).not.toContain("--caustic");
  });

  test("renders no error banner and no candidate list at rest", () => {
    // Data rule 5 / rule 1: no dead controls, and colour only for real state.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("pick the one to connect");
  });
});

describe("TokenCandidateList (the `multiple` outcome)", () => {
  const picker = renderToStaticMarkup(
    <TokenCandidateList
      busy={false}
      onPick={() => {}}
      candidates={[
        {
          wabaId: "WABA_ONE",
          phones: [{ phoneNumberId: "PN1", displayPhoneNumber: "+34600000001" }],
        },
        { wabaId: "WABA_TWO", phones: [] },
      ]}
    />,
  );

  test("offers one row per account, and says nothing was attached", () => {
    // INVARIANT: ambiguity is answered with a question. A pasted system-user
    // token can see every WABA a business manages, so this list existing at all
    // is what stands between one paste and mass-attaching an agency's clients.
    expect(picker).toContain("Nothing was attached");
    expect(picker).toContain("WABA_ONE");
    expect(picker).toContain("+34600000001");
    expect(picker).toContain("WABA_TWO");
    // A WABA with no phone is still shown, and says so rather than rendering an
    // empty line the operator has to interpret.
    expect(picker).toContain("No phone number");
    expect((picker.match(/<button/g) ?? []).length).toBe(2);
  });

  test("uses the ghost-row anatomy, square", () => {
    expect(picker).toContain("border-(--line-strong)");
    expect(picker).toContain("bg-(--ghost-fill)");
    expect(picker).toContain("hover:border-(--ghost-edge-hover)");
    expect(picker).toContain("rounded-none");
  });
});
