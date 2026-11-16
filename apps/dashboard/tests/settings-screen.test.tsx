import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Settings page (`routes/settings.tsx`), rendered through the router-free
 * `SettingsView`: Workspace, Billing and Conversation history as full-width
 * two-column sections, each titled in the left third.
 * API keys live on /api-keys (`tests/api-keys-screen.test.tsx`), and the panels
 * that left earlier must not come back.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { SettingsView } = await import("../src/routes/settings");
const { roleLabel } = await import("../src/components/dashboard/workspace-panel");
const { ConversationRetentionPanel, RETENTION_CHOICES, saveRetentionChoice } = await import(
  "../src/components/dashboard/conversation-retention"
);

const workspace = { id: "org-a", name: "Citta", role: "owner" };
const billing = {
  connectPolicy: "open" as const,
  explicitPolicy: true,
  hasCustomer: true,
  numbers: 1,
  monthlyEuros: 8,
};

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("SettingsView, owner or admin", () => {
  const html = renderToStaticMarkup(
    <SettingsView
      accountId="account-a"
      workspace={workspace}
      canAdminister
      billing={billing}
      retention={{ ok: true, data: null }}
    />,
  );

  test("the Workspace panel names the workspace, the account id with a copy control, and the role", () => {
    expect(html).toContain("Citta");
    expect(html).toContain("Rename");
    expect(html).toContain("account-a");
    expect(html).toContain("Copy");
    expect(text(html)).toContain("Your role Owner");
    // A role is a state word: the neutral square tag, not prose.
    expect(html).toMatch(/<span class="[^"]*border-\(--line-strong\)[^"]*">Owner<\/span>/);
  });

  test("full-width sections, ordered Workspace, Billing, Conversation history, each titled and anchored", () => {
    expect(html).not.toMatch(/max-w-(3xl|4xl|5xl)/);
    for (const title of ["Workspace", "Billing", "Conversation history"]) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>${title}</h2>`));
    }
    const order = ['id="workspace"', 'id="billing"', 'id="conversation-history"'].map((id) => html.indexOf(id));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("API keys are not here any more", () => {
    expect(html).not.toContain("API keys");
    expect(html).not.toContain("Create key");
    expect(html).not.toContain("Bearer");
  });

  test("the panels that moved earlier did not come back", () => {
    for (const gone of ["Attach by token", "Meta access token", "Forwarding target", "Re-subscribe", "attach-token"]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("SettingsView, without administer", () => {
  const html = renderToStaticMarkup(
    <SettingsView accountId="account-a" workspace={{ ...workspace, role: "operator" }} billingOn />,
  );

  test("the Workspace panel only, read-only", () => {
    expect(html).toContain("Citta");
    expect(html).toContain("account-a");
    expect(text(html)).toContain("Your role Operator");
    expect(html).not.toContain("Rename");
    expect(html).not.toContain('id="billing"');
    expect(html).not.toContain("Conversation history");
  });

  test("one note, a title and a sentence, explains who manages the rest; no panel refuses on its own", () => {
    expect(text(html)).toContain(
      "Managed by an owner or admin An owner or admin of this workspace manages billing and conversation history.",
    );
    expect(html).not.toContain("Not available to your role");
  });

  test("with billing off for the deployment, the note does not mention billing", () => {
    const off = renderToStaticMarkup(<SettingsView accountId="account-a" workspace={workspace} />);
    expect(off).toContain("An owner or admin of this workspace manages conversation history.");
    expect(off).not.toContain("billing");
  });
});

describe("SettingsView when the root read failed", () => {
  test("an owner whose root read failed sees that failure, not a role refusal", () => {
    const html = renderToStaticMarkup(
      <SettingsView rootFailure={{ ok: false, kind: "unreachable", error: "fetch failed" }} accountId="account-a" />,
    );
    expect(html).toContain("Gateway unreachable");
    expect(html).not.toContain("Managed by an owner or admin");
    expect(html).not.toContain("Account ID");
  });
});

describe("SettingsView, admin reads refused for a non-admin", () => {
  test("the refused reads are not rendered", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        accountId="account-a"
        workspace={{ ...workspace, role: "viewer" }}
        retention={{ ok: false, kind: "forbidden", reason: "missing-permission", error: "missing" }}
      />,
    );
    expect(html).toContain("Managed by an owner or admin");
    expect(html).not.toContain("Not available to your role");
    expect(html).not.toContain("Keep conversations");
  });
});

describe("SettingsView before an account exists", () => {
  test("renders the page chrome and stops, with no failure card", () => {
    const empty = renderToStaticMarkup(<SettingsView />);
    expect(empty).toContain("Settings");
    expect(empty).not.toContain("Gateway unreachable");
    expect(empty).not.toContain("Account ID");
  });
});

test("roleLabel reads a comma-separated role string", () => {
  expect(roleLabel("admin")).toBe("Admin");
  expect(roleLabel("owner,admin")).toBe("Owner, Admin");
});

describe("Conversation history control (Settings)", () => {
  test("renders the control with keep-forever as the default and the three windows", () => {
    const html = renderToStaticMarkup(
      <SettingsView accountId="account-a" canAdminister retention={{ ok: true, data: null }} />,
    );
    expect(html).toContain("Conversation history");
    expect(html).toContain("The short buffer used for forwarding is separate");
    expect(html).toContain("Keep conversations");
    expect(html).toContain("Keep forever");
    expect(RETENTION_CHOICES.map((choice) => choice.label)).toEqual([
      "Keep forever",
      "Delete after 30 days",
      "Delete after 90 days",
      "Delete after 365 days",
    ]);
  });

  test("the control is quiet until a window is chosen, then says what it deletes", () => {
    const forever = renderToStaticMarkup(
      <ConversationRetentionPanel retention={{ ok: true, data: null }} />,
    );
    expect(forever).not.toContain("Older conversations and contacts are deleted");
    expect(forever).toContain("disabled");

    const windowed = renderToStaticMarkup(
      <ConversationRetentionPanel retention={{ ok: true, data: 90 }} />,
    );
    expect(windowed).toContain("Delete after 90 days");
    expect(windowed).toContain("Older conversations and contacts are deleted");
  });

  test("a refusal from the server on a stale root flag still reads as a refusal, not a control", () => {
    const html = renderToStaticMarkup(
      <ConversationRetentionPanel
        retention={{ ok: false, kind: "forbidden", reason: "missing-permission", error: "missing" }}
      />,
    );
    expect(html).toContain("Not available to your role");
    expect(html).not.toContain("Keep conversations");
  });

  test("the copy keeps to plain sentences and no em dash", () => {
    const html = renderToStaticMarkup(
      <ConversationRetentionPanel retention={{ ok: true, data: 30 }} />,
    );
    expect(html).not.toContain("—");
    expect(html).not.toContain("–");
  });
});

describe("saveRetentionChoice (the Save outcome)", () => {
  test("sends keep-forever as null and a window as its day count", async () => {
    const sent: Array<number | null> = [];
    const save = async (days: number | null) => {
      sent.push(days);
      return { ok: true as const, data: days };
    };
    expect(await saveRetentionChoice("forever", save)).toEqual({ ok: true });
    expect(await saveRetentionChoice("90", save)).toEqual({ ok: true });
    expect(sent).toEqual([null, 90]);
  });

  test("reports a failed Result with its copy, and does not throw", async () => {
    const outcome = await saveRetentionChoice("30", async () => ({
      ok: false,
      kind: "unreachable",
      error: "fetch failed: ECONNREFUSED",
    }));
    expect(outcome).toEqual({ ok: false, error: "fetch failed: ECONNREFUSED" });
  });

  test("a save that never reaches the server is reported, not left unhandled, and a retry can succeed", async () => {
    let attempts = 0;
    const save = async (days: number | null) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return { ok: true as const, data: days };
    };
    const first = await saveRetentionChoice("365", save);
    expect(first.ok).toBe(false);
    expect(first.ok ? "" : first.error).toContain("Failed to fetch");
    expect(await saveRetentionChoice("365", save)).toEqual({ ok: true });
  });
});

describe("rootRole (what both loaders and pages read from the root)", () => {
  test("reads the role and whether billing is on, and nothing before an account exists", async () => {
    const { rootRole } = await import("../src/lib/root-role");
    const resources = { account: null, keys: [], wabas: [], phones: [] };
    expect(
      rootRole({ ok: true, data: { stage: "account-ready", resources, canAdminister: false, role: "viewer" } }),
    ).toEqual({ canAdminister: false, role: "viewer", billing: false });
    expect(
      rootRole({
        ok: true,
        data: {
          stage: "account-ready",
          resources,
          canAdminister: true,
          role: "owner",
          billing: { subscribed: false, canManage: true },
        },
      }),
    ).toEqual({ canAdminister: true, role: "owner", billing: true });
    expect(rootRole({ ok: true, data: { stage: "no-organization" } })).toBeNull();
    expect(rootRole({ ok: false, kind: "unreachable", error: "down" })).toBeNull();
    expect(rootRole(undefined)).toBeNull();
  });
});
