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

const { TokenConnectPanel, TokenCandidateList, WabaIdQuestion } = await import(
  "../src/components/dashboard/connect-token"
);
const { tokenConnectFailureCopy } = await import("../src/lib/failure");

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
    // Progressive disclosure: the WABA-id field is an ANSWER to a question the
    // gateway has not asked yet. Showing it at rest would ask every operator
    // for an id most of them never need.
    expect(html).not.toContain('id="connect-waba-id"');
    expect(html).not.toContain("Nothing was attached");
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

/**
 * The question a `no_waba` outcome asks (eccos-up9 follow-up).
 *
 * It exists because `debug_token`'s `target_ids` is nullable and was measured
 * ABSENT on a System User token that could read its WABA fine — so the console
 * stopped calling that a dead end and started asking. Rendered directly for the
 * same reason as `TokenCandidateList`: it only ever appears after a submit,
 * which static rendering cannot reach.
 */
describe("WabaIdQuestion (the no_waba outcome)", () => {
  const asked = renderToStaticMarkup(
    <WabaIdQuestion value="" onChange={() => {}} explain />,
  );
  const answered = renderToStaticMarkup(
    <WabaIdQuestion value="100000000000001" onChange={() => {}} explain={false} />,
  );

  test("asks as a question and says nothing was attached", () => {
    // INVARIANT: the panel names the fact that produced the question (Meta did
    // not say), and states that nothing was registered — the same discipline as
    // the `multiple` fork, where asking is what stands between one paste and a
    // wrong attachment.
    expect(asked).toContain("did not say which WhatsApp Business");
    expect(asked).toContain("Nothing was attached");
    expect(asked).toContain("WhatsApp Business Account id");
    expect(asked).toContain('id="connect-waba-id"');
    expect(asked).toMatch(/required/);
    expect(asked).toMatch(/inputmode="numeric"/i);
    expect(asked).toMatch(/autocomplete="off"/i);
  });

  test("does not promise the id will work, and echoes no token", () => {
    // Whether the token can read that account is Meta's answer, not ours. The
    // copy asks Meta; it does not predict the reply.
    expect(asked).not.toMatch(/will (work|attach|connect)/i);
    expect(asked).not.toContain("EAA");
  });

  test("keeps the two laws: square corners, machine-voice labels", () => {
    const stripped = asked
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
    expect(asked).toContain("text-[11px] font-medium tracking-wider text-muted-foreground uppercase");
    expect(asked).toContain("Digits only");
  });

  test("after a refused answer the field stays and the question does not repeat", () => {
    // The banner is explaining the refusal by then, so re-asking the same
    // question underneath it would read as if nothing had been submitted.
    expect(answered).not.toContain("Nothing was attached");
    expect(answered).toContain('id="connect-waba-id"');
    expect(answered).toContain('value="100000000000001"');
  });
});

/**
 * The copy for a refusal of an id the operator supplied.
 *
 * Keyed on the closed code alone, never on Meta's text — and each code says
 * something the others cannot: `no_access` names both remedies (Graph answers a
 * mistyped id and an unassigned asset identically), `no_phone` says the read
 * WORKED, and `no_waba` is the one that asks for an id in the first place.
 */
describe("tokenConnectFailureCopy for a named id", () => {
  test("no_access names both remedies and carries Meta's sentence", () => {
    const copy = tokenConnectFailureCopy("no_access", "Unsupported get request.");
    expect(copy.detail).toContain("Check the id");
    expect(copy.detail).toEndWith("Meta said: Unsupported get request.");
    expect(tokenConnectFailureCopy("no_access", null).detail).not.toContain("Meta said");
  });

  test("no_phone says the read worked and only the number is missing", () => {
    expect(tokenConnectFailureCopy("no_phone", null).detail).toContain("no phone number on it");
  });

  test("no_waba asks for the id rather than declaring a dead end", () => {
    expect(tokenConnectFailureCopy("no_waba", null).detail).toContain("Enter the account's id");
  });

  test("none of them can carry a token", () => {
    for (const code of ["no_access", "no_phone", "no_waba"] as const) {
      expect(tokenConnectFailureCopy(code, null).detail).not.toContain("EAA");
    }
  });
});
