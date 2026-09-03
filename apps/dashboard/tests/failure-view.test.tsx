import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

import { failureCopy } from "../src/lib/failure";
import type { Failure } from "../src/server/gateway";

/**
 * What every `{ ok: false }` puts on screen (eccos-k5a).
 *
 * The defect this covers: one card, "Gateway unreachable — the dashboard could
 * not reach the gateway over the GATEWAY service binding", rendered for BOTH a
 * dead service binding and an authorization refusal that happened in the
 * identity plane before any RPC was attempted. A signed-in user who simply
 * belongs to no workspace was told to go check a Worker deployment.
 *
 * `FailureView` pulls in `src/server/gateway.ts` and `src/organizations.ts`,
 * which import `cloudflare:workers` and `@tanstack/react-start`; both are mocked
 * exactly as in `tests/gateway.test.ts` before the real component is imported.
 * React's own `react-dom/server` needs no DOM.
 */
installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { FailureView } = await import("../src/components/dashboard/failure");

function render(failure: Failure): string {
  return renderToStaticMarkup(<FailureView failure={failure} />);
}

/** The sentence the old card asserted, and the only state entitled to it. */
const GATEWAY_BLAME = "could not reach the gateway";

describe("FailureView: authorization is not an outage", () => {
  test("no membership: offers a workspace to create, never a Worker to check", () => {
    const html = render({
      ok: false,
      kind: "forbidden",
      reason: "no-organization",
      error: "no organization membership — create or join an organization first",
    });
    expect(html).toContain("No workspace yet");
    expect(html).toContain("Create a workspace");
    expect(html).toContain('href="/onboarding"');
    // The regression this issue is about.
    expect(html).not.toContain("Gateway unreachable");
    expect(html).not.toContain(GATEWAY_BLAME);
    expect(html).not.toContain("service binding");
    // No raw server message leaking into copy meant for an operator.
    expect(html).not.toContain("no organization membership");
  });

  test("several workspaces: renders the choice, not a diagnosis", () => {
    const html = render({
      ok: false,
      kind: "forbidden",
      reason: "select-organization",
      error: "select an organization",
      organizations: [
        { id: "org-a", name: "Acme" },
        { id: "org-b", name: "Globex" },
      ],
    });
    expect(html).toContain("Choose a workspace");
    expect(html).toContain("Acme");
    expect(html).toContain("Globex");
    expect(html).toContain("Your workspaces");
    expect(html).not.toContain("Gateway unreachable");
    expect(html).not.toContain(GATEWAY_BLAME);
  });

  test("identically named workspaces are told apart by a short id, nothing else", () => {
    // Names may repeat now that the slug is opaque and server-minted. The
    // picker answers the ambiguity with the first six characters of the
    // organization id — and ONLY on the rows that are actually ambiguous.
    const html = render({
      ok: false,
      kind: "forbidden",
      reason: "select-organization",
      error: "select an organization",
      organizations: [
        { id: "org-aaaaaa1", name: "Citta" },
        { id: "org-bbbbbb2", name: "Citta" },
        { id: "org-c", name: "Globex" },
      ],
    });
    expect(html).toContain(">org-aa<");
    expect(html).toContain(">org-bb<");
    // Globex is unambiguous, so it gets a name and nothing under it.
    expect(html.match(/font-mono/g)?.length).toBe(2);
  });

  test("a picker of distinctly named workspaces shows no sub-lines at all", () => {
    const html = render({
      ok: false,
      kind: "forbidden",
      reason: "select-organization",
      error: "select an organization",
      organizations: [
        { id: "org-a", name: "Acme" },
        { id: "org-b", name: "Globex" },
      ],
    });
    expect(html).not.toContain("font-mono");
  });

  test("several workspaces but no list resolved: the sentence stands alone", () => {
    // Degrades to no picker rather than to an empty one or a wrong cause.
    const html = render({
      ok: false,
      kind: "forbidden",
      reason: "select-organization",
      error: "select an organization",
    });
    expect(html).toContain("Choose a workspace");
    expect(html).not.toContain("Your workspaces");
  });

  test("a narrow role: says the role, not the infrastructure", () => {
    const html = render({
      ok: false,
      kind: "forbidden",
      reason: "missing-permission",
      error: 'missing "configure" permission in this organization',
    });
    expect(html).toContain("Not available to your role");
    expect(html).not.toContain("Gateway unreachable");
    expect(html).not.toContain(GATEWAY_BLAME);
  });

  test("a lost session: offers sign-in", () => {
    const html = render({ ok: false, kind: "unauthenticated", error: "authentication required" });
    expect(html).toContain("Signed out");
    expect(html).toContain('href="/signin"');
    expect(html).not.toContain("Gateway unreachable");
  });
});

describe("FailureView: a real transport failure still blames the gateway", () => {
  test("keeps the unreachable card, the binding name, and the raw error", () => {
    const html = render({
      ok: false,
      kind: "unreachable",
      error: "fetch failed: ECONNREFUSED",
    });
    expect(html).toContain("Gateway unreachable");
    expect(html).toContain(GATEWAY_BLAME);
    expect(html).toContain("GATEWAY");
    expect(html).toContain("fetch failed: ECONNREFUSED");
  });
});

describe("FailureView: console design rules", () => {
  const cases: Failure[] = [
    { ok: false, kind: "forbidden", reason: "no-organization", error: "x" },
    {
      ok: false,
      kind: "forbidden",
      reason: "select-organization",
      error: "x",
      organizations: [{ id: "org-a", name: "Acme" }],
    },
    { ok: false, kind: "unauthenticated", error: "x" },
  ];

  test("no red banner: a choice the operator has not made is not a failure", () => {
    // docs/DASHBOARD-DESIGN.md data rule 1: colour is spent only on states an
    // operator has to act on as a fault. #e03131 / #ff7777 are those inks.
    for (const failure of cases) {
      const html = render(failure);
      expect(html).not.toContain("#e03131");
      expect(html).not.toContain("#ff7777");
    }
  });

  test("nothing rounds a corner", () => {
    for (const failure of cases) {
      const stripped = render(failure)
        .replace(/rounded-none/g, "")
        .replace(/rounded-\([^)]*\)/g, "")
        .replace(/rounded-\[[^\]]*\]/g, "");
      expect(stripped).not.toMatch(/rounded-/);
    }
  });
});

describe("failureCopy (the mapping both the page and the inline notices use)", () => {
  test("branches on the reason code, never on the message", () => {
    // Same message, different reason: the copy must follow the code.
    const same = "select an organization";
    expect(failureCopy({ ok: false, kind: "forbidden", reason: "no-organization", error: same }).title).toBe(
      "No workspace yet",
    );
    expect(
      failureCopy({ ok: false, kind: "forbidden", reason: "select-organization", error: same }).title,
    ).toBe("Choose a workspace");
  });

  test("an unclassified refusal reports itself rather than inventing a cause", () => {
    const copy = failureCopy({
      ok: false,
      kind: "forbidden",
      reason: "other",
      error: "organization mismatch",
    });
    expect(copy.title).toBe("Not allowed");
    expect(copy.detail).toBe("organization mismatch");
  });

  test("only the transport failure carries the gateway's own message", () => {
    const copy = failureCopy({ ok: false, kind: "unreachable", error: "RPC timeout" });
    expect(copy.title).toBe("Gateway unreachable");
    expect(copy.detail).toBe("RPC timeout");
  });
});
