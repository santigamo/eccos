import { describe, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AccountResources,
  CoexistenceResource,
  CoexistenceSyncStatus,
} from "@eccos/gateway-contract";

/**
 * Rendering contract for the /numbers table (eccos-lpk).
 *
 * The Embedded Signup callback now provisions before it hands the operator
 * back, so a `pending` row is the tail case rather than the normal one — and
 * the tail is exactly what used to be a bare amber tag with no explanation and
 * no way out. These tests pin the two halves of the fix: pending says what it
 * means, and the row that can still change carries the action.
 *
 * Same import gymnastics as `numbers-screen.test.tsx`: the component imports
 * `src/server/gateway.ts`, which pulls `cloudflare:workers` and
 * `@tanstack/react-start`, so both are mocked BEFORE the real import. React's
 * own `react-dom/server` needs no DOM.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { NumbersTable } = await import("../src/components/dashboard/numbers-table");
const { recheckNotice } = await import("../src/lib/provisioning-copy");

type Status = "pending" | "active" | "failed";

/** Default coexistence state: an ordinary number that owes Meta nothing. */
function coexistenceOf(status: CoexistenceSyncStatus): CoexistenceResource {
  return {
    onboardingType: status === "not_applicable" ? "standard" : "coexistence",
    verifiedOnboardingType: status === "not_coexistence" ? "standard" : null,
    status,
    deadlineAt: null,
    contactsStartedAt: null,
    contactsRequestId: null,
    historyStartedAt: null,
    historyRequestId: null,
    error: null,
  };
}

function resources(
  ...wabas: Array<{
    wabaId: string;
    status: Status;
    phones: number;
    coexistence?: CoexistenceSyncStatus;
  }>
): AccountResources {
  return {
    account: { accountId: "account-a", name: "Account A", createdAt: 1 },
    keys: [],
    wabas: wabas.map((waba) => ({
      accountId: "account-a",
      wabaId: waba.wabaId,
      callbackUrl: null,
      createdAt: 1,
      provisionedAt: waba.status === "active" ? 2 : null,
      status: waba.status,
      provisioningError: waba.status === "failed" ? "subscribed_apps failed with HTTP 400" : null,
      phones: Array.from({ length: waba.phones }, (_, index) => ({
        phoneNumberId: `${waba.wabaId}-phone-${index}`,
        displayPhoneNumber: `+34 600 000 00${index}`,
      })),
      coexistence: coexistenceOf(waba.coexistence ?? "not_applicable"),
    })),
    phones: [],
  };
}

function render(state: AccountResources): string {
  return renderToStaticMarkup(<NumbersTable resources={state} />);
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("NumbersTable", () => {
  test("an active number is quiet: a tag, and no action to take", () => {
    const html = render(resources({ wabaId: "waba-a", status: "active", phones: 1 }));
    expect(html).toContain("active");
    expect(html).not.toContain("Re-check");
    // Colour and copy are spent on state that means something; waiting copy has
    // no business on a connected number.
    expect(text(html)).not.toContain("Waiting on Meta");
  });

  test("a pending number says what pending means", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    const body = text(html);
    expect(body).toContain("Waiting on Meta");
    expect(body).toContain("subscribing it to its Meta webhooks");
    // And it says the wait is not the operator's to babysit.
    expect(body).toContain("keeps retrying on its own");
  });

  test("a pending number offers the re-check that can change it", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    expect(html).toContain("Re-check");
    expect(html).toContain('aria-label="Re-check +34 600 000 000"');
  });

  test("a failed number can be re-checked too, and an active one cannot", () => {
    const html = render(
      resources(
        { wabaId: "waba-failed", status: "failed", phones: 1 },
        { wabaId: "waba-ok", status: "active", phones: 1 },
      ),
    );
    expect(html.match(/Re-check\b/g) ?? []).toHaveLength(2); // aria-label + button text
    // The active row holds the column's rhythm with a muted em-dash.
    expect(html).toContain('<span class="text-muted-foreground">—</span>');
  });

  test("the waiting note counts rows, not accounts", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 2 }));
    expect(text(html)).toContain("2 numbers are registered");
  });

  test("the live region is mounted before it has anything to announce", () => {
    // An element that appears with its message is not reliably announced; one
    // that fills up is.
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    expect(html).toContain('aria-live="polite"');
  });

  test("the table stays square and keeps its machine-voice headers", () => {
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 1 }));
    const stripped = html
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
    expect(html).toContain("tracking-wider");
    expect(text(html)).toContain("Action");
  });

  /**
   * The coexistence correction (eccos-vss, item 3). Eccos asked Meta for a
   * WhatsApp Business app onboarding and Meta reports it did not perform one,
   * so the once-only contacts and history syncs were deliberately never
   * requested. The number works — it must not read as broken — but nobody
   * should be left waiting for chat history that is not coming.
   */
  test("a number Meta says is not a coexistence number says so, without alarming", () => {
    const html = render(
      resources({
        wabaId: "waba-a",
        status: "active",
        phones: 1,
        coexistence: "not_coexistence",
      }),
    );
    const body = text(html);
    expect(body).toContain("No WhatsApp Business app history");
    expect(body).toContain("were not synchronised and will not be");
    // Informational, not a failure: the row keeps its active tag and offers no
    // re-check, because there is nothing a re-check could change.
    expect(body).not.toContain("failed");
  });

  test("the note counts numbers and stays away from healthy ones", () => {
    const clean = text(render(resources({ wabaId: "waba-a", status: "active", phones: 2 })));
    expect(clean).not.toContain("No WhatsApp Business app history");

    const affected = text(
      render({
        ...resources({
          wabaId: "waba-a",
          status: "active",
          phones: 2,
          coexistence: "not_coexistence",
        }),
      }),
    );
    expect(affected).toContain("2 numbers were connected");
  });

  test("a refused sync says which data was not imported and what to do, without operator wording", () => {
    const state = resources({ wabaId: "waba-a", status: "active", phones: 1, coexistence: "unavailable" });
    const coexistence = state.wabas[0]!.coexistence;
    coexistence.contactsRequestId = "unavailable:not_permitted";
    coexistence.historyRequestId = "unavailable:history_sharing_off";
    coexistence.error =
      "contacts sync unavailable: Meta refused it with a permission error. The number works as a Cloud API number without that data";
    const body = text(render(state));
    expect(body).toContain("Some WhatsApp Business app data was not imported");
    expect(body).toContain("contacts were not imported: Meta did not allow it for this number. Contact Eccos support.");
    expect(body).toContain("history sharing was off when the number was connected");
    expect(body).not.toContain("Cloud API number");
    expect(body).not.toContain("offboard");
    expect(text(render(resources({ wabaId: "waba-a", status: "active", phones: 1, coexistence: "initiated" })))).not.toContain(
      "was not imported",
    );
  });

  test("an already-used sync says it cannot be repeated by the customer", () => {
    const state = resources({ wabaId: "waba-a", status: "active", phones: 1, coexistence: "unavailable" });
    state.wabas[0]!.coexistence.historyRequestId = "unavailable:already_synced";
    const body = text(render(state));
    expect(body).toContain("chat history was not imported: Meta allows that import once per number");
    expect(body).toContain("contact Eccos support");
  });

  test("a failed WABA never claims the number works, and equal reasons show once", () => {
    const failed = resources({ wabaId: "waba-a", status: "failed", phones: 1, coexistence: "unavailable" });
    expect(text(render(failed))).not.toContain("was not imported");

    const two = resources(
      { wabaId: "waba-a", status: "active", phones: 1, coexistence: "unavailable" },
      { wabaId: "waba-b", status: "active", phones: 1, coexistence: "unavailable" },
    );
    for (const waba of two.wabas) waba.coexistence.contactsRequestId = "unavailable:not_permitted";
    expect(text(render(two)).split("contacts were not imported")).toHaveLength(2);
  });

  test("an unconfirmed sync on a failed WABA is told plainly, with no operator wording", () => {
    const state = resources({ wabaId: "waba-a", status: "failed", phones: 1, coexistence: "unconfirmed" });
    state.wabas[0]!.provisioningError =
      "coexistence sync was issued but not confirmed by Meta and cannot be safely retried (each sync is allowed once); offboard this customer and onboard it again";
    const body = text(render(state));
    expect(body).toContain("Connection failed");
    expect(body).toContain("+34 600 000 000");
    expect(body).toContain("This number is not connected: Eccos could not confirm");
    expect(body).toContain("Contact Eccos support.");
    expect(body).not.toContain("offboard");
    expect(body).not.toContain("works normally");
  });

  test("an expired history window on a failed WABA is told plainly", () => {
    const body = text(render(resources({ wabaId: "waba-a", status: "failed", phones: 1, coexistence: "expired" })));
    expect(body).toContain("the 24-hour window to import your WhatsApp Business app chat history ran out");
    expect(body).not.toContain("offboard");
  });

  test("a failed WABA with a sync already requested never says to connect again", () => {
    const pending = resources({ wabaId: "waba-a", status: "failed", phones: 1, coexistence: "pending" });
    Object.assign(pending.wabas[0]!.coexistence, {
      contactsStartedAt: 1,
      contactsRequestId: "accepted",
      historyStartedAt: 2,
    });
    const settled = resources({ wabaId: "waba-b", status: "failed", phones: 1, coexistence: "unavailable" });
    Object.assign(settled.wabas[0]!.coexistence, {
      contactsStartedAt: 1,
      contactsRequestId: "unavailable:not_permitted",
    });
    for (const state of [pending, settled]) {
      const body = text(render(state));
      expect(body).toContain("Contact Eccos support.");
      expect(body).not.toContain("Connect it again");
    }
  });

  test("an unconfirmed sync names only the sync in doubt, and a numberless account is not a number", () => {
    const state = resources({ wabaId: "waba-a", status: "failed", phones: 0, coexistence: "unconfirmed" });
    Object.assign(state.wabas[0]!.coexistence, {
      contactsStartedAt: 1,
      contactsRequestId: "accepted",
      historyStartedAt: 2,
    });
    const body = text(render(state));
    expect(body).toContain("This account is not connected");
    expect(body).toContain("chat history import finished");
    expect(body).not.toContain("contacts and chat history");
  });

  test("the re-check notice does not promise retries once the WABA failed", () => {
    expect(recheckNotice("failed")).toContain("See the note below");
    expect(recheckNotice("failed")).not.toContain("keep retrying");
    expect(recheckNotice("pending")).toContain("keep retrying");
  });

  test("unavailable lines name the number when the account has several", () => {
    const two = resources(
      { wabaId: "waba-a", status: "active", phones: 1, coexistence: "unavailable" },
      { wabaId: "waba-b", status: "active", phones: 1, coexistence: "unavailable" },
    );
    two.wabas[0]!.coexistence.contactsRequestId = "unavailable:not_permitted";
    two.wabas[1]!.coexistence.historyRequestId = "unavailable:history_sharing_off";
    expect(text(render(two))).toContain("+34 600 000 000: Your WhatsApp Business app contacts were not imported");
  });

  test("a coexistence note never claims a failed number works", () => {
    const body = text(render(resources({ wabaId: "waba-a", status: "failed", phones: 1, coexistence: "not_coexistence" })));
    expect(body).not.toContain("works normally");
  });

  test("a coexistence number that synchronised normally shows no note", () => {
    const html = text(
      render(resources({ wabaId: "waba-a", status: "active", phones: 1, coexistence: "initiated" })),
    );
    expect(html).not.toContain("No WhatsApp Business app history");
  });

  /**
   * Embedded Signup v4 can complete with no phone number. The table is built
   * from numbers, so a WABA without one renders no rows — it would be connected
   * and completely invisible without a note of its own.
   */
  test("a connected account with no number is visible instead of silently absent", () => {
    const html = text(render(resources({ wabaId: "waba-a", status: "pending", phones: 0 })));
    expect(html).toContain("Waiting on a phone number");
    expect(html).toContain("nothing needs reconnecting");
  });

  test("the waiting note carries the action that ends the wait", () => {
    // "On its own" means the five-minute cron. An operator who has just added
    // the number in WhatsApp Manager should not have to sit through it — the
    // same reconciler the row-level Re-check runs also adopts newly-appeared
    // phones, and the note is the only place it can be offered, because a
    // phoneless WABA produces no row to hang a button on.
    const html = render(resources({ wabaId: "waba-a", status: "pending", phones: 0 }));
    expect(text(html)).toContain("Check now");
    expect(html).toContain('aria-label="Check waba-a for a phone number now"');
  });

  test("the note stays away from accounts that do have numbers", () => {
    const html = text(render(resources({ wabaId: "waba-a", status: "active", phones: 1 })));
    expect(html).not.toContain("Waiting on a phone number");
  });

  /**
   * The two zero-phone states say opposite things, and both are invisible in
   * the table itself because rows come from phone numbers. Waiting resolves on
   * its own; failed does not.
   */
  test("a failed account with no number is not told to sit and wait", () => {
    const html = text(render(resources({ wabaId: "waba-a", status: "failed", phones: 0 })));
    expect(html).toContain("Connection failed");
    expect(html).toContain("Eccos could not finish connecting this number");
    expect(html).not.toContain("subscribed_apps");
    // The waiting note would be a lie here: nothing is coming.
    expect(html).not.toContain("Waiting on a phone number");
  });

  test("waiting and failed accounts are counted separately", () => {
    const html = text(
      render(
        resources(
          { wabaId: "waba-waiting", status: "pending", phones: 0 },
          { wabaId: "waba-broken", status: "failed", phones: 0 },
        ),
      ),
    );
    expect(html).toContain("One WhatsApp Business account is connected but has no business phone number yet");
    expect(html).toContain("Connection failed");
    expect(html).toContain("waba-broken");
  });
});
