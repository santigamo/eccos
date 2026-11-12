/**
 * The operator's side of step-up (eccos-eyel): a refused sensitive action is
 * resolved in place and retried, never a dead end and never a lost form.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { failureCopy } from "../src/lib/failure";
import { lockedMessage, totpSecret, twoFactorErrorMessage } from "../src/lib/two-factor";
import type { Failure } from "../src/server/gateway";

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { promptStepUp, registerStepUpPrompt, settleStepUp, STEP_UP_COPY, withStepUp } = await import(
  "../src/lib/step-up"
);
const { heldBackupCodes, showBackupCodes } = await import("../src/lib/backup-codes");
const { BackupCodesSheet } = await import("../src/components/dashboard/backup-codes-sheet");
const { BackupCodes, TwoFactorPanel } = await import("../src/components/dashboard/two-factor");
const { QrCode } = await import("../src/components/dashboard/qr-code");
const { SettingsView } = await import("../src/routes/settings");
const { TwoFactorForm } = await import("../src/components/blocks/auth-13/components/two-factor-form");

const refusal = (reason: Failure["reason"]): Failure => ({
  ok: false,
  kind: "forbidden",
  reason,
  error: "server words",
});

describe("withStepUp", () => {
  let unregister = () => {};
  afterEach(() => unregister());

  /** A call refused once for `reason`, then accepted. */
  function sensitive(reason: Failure["reason"]) {
    let calls = 0;
    return {
      calls: () => calls,
      call: async () => (++calls === 1 ? refusal(reason) : { ok: true as const, data: "done" }),
    };
  }

  /** A mounted prompt that answers `answer` as soon as it is shown. */
  function prompt(answer: boolean) {
    const shown: string[] = [];
    unregister = registerStepUpPrompt((reason) => {
      if (!reason) return;
      shown.push(reason);
      queueMicrotask(() => settleStepUp(answer));
    });
    return shown;
  }

  test("a refusal is put to the operator, and the call runs again once they confirm", async () => {
    const shown = prompt(true);
    for (const reason of ["totp-required", "reauth-required"] as const) {
      const action = sensitive(reason);
      expect(await withStepUp(action.call)).toEqual({ ok: true, data: "done" });
      expect(action.calls()).toBe(2);
    }
    expect(shown).toEqual(["totp-required", "reauth-required"]);
  });

  test("a declined prompt hands back the refusal and does not retry", async () => {
    prompt(false);
    const action = sensitive("reauth-required");
    expect(await withStepUp(action.call)).toEqual(refusal("reauth-required"));
    expect(action.calls()).toBe(1);
  });

  test("with no prompt mounted the refusal still reaches the caller's own copy", async () => {
    const action = sensitive("totp-required");
    expect(await withStepUp(action.call)).toEqual(refusal("totp-required"));
  });

  test("success and every other failure pass straight through, unasked", async () => {
    const shown = prompt(true);
    const denied = refusal("missing-permission");
    expect(await withStepUp(async () => denied)).toBe(denied);
    expect(await withStepUp(async () => ({ ok: true as const, data: 1 }))).toEqual({ ok: true, data: 1 });
    expect(shown).toEqual([]);
  });

  test("a second prompt declines the first instead of leaving it waiting", async () => {
    unregister = registerStepUpPrompt(() => {});
    const first = promptStepUp("reauth-required");
    const second = promptStepUp("totp-required");
    expect(await first).toBe(false);
    settleStepUp(true);
    expect(await second).toBe(true);
  });

  test("a dialog's own sheet answers while it is mounted, and the shell's again once it is gone", async () => {
    const shell: (string | null)[] = [];
    const dialog: (string | null)[] = [];
    unregister = registerStepUpPrompt((reason) => void shell.push(reason));
    const closeDialog = registerStepUpPrompt((reason) => void dialog.push(reason));

    const inDialog = promptStepUp("reauth-required");
    expect([shell, dialog]).toEqual([[], ["reauth-required"]]);
    closeDialog();
    expect(await inDialog).toBe(false);

    const onPage = promptStepUp("totp-required");
    expect(shell).toEqual(["totp-required"]);
    settleStepUp(true);
    expect(await onPage).toBe(true);
  });

  test("a prompt still waiting when the sheet unmounts is declined, not lost", async () => {
    const shown: (string | null)[] = [];
    const leave = registerStepUpPrompt((reason) => void shown.push(reason));
    const waiting = promptStepUp("reauth-required");
    leave();
    expect(await waiting).toBe(false);
    // Closed on the way out, and nothing is asked of a sheet that is gone.
    expect(shown.at(-1)).toBeNull();
    expect(await promptStepUp("reauth-required")).toBe(false);
  });
});

describe("backup codes held at the app's root", () => {
  test("stay on screen when the surface that enrolled goes away, until confirmed", async () => {
    const leave = registerStepUpPrompt(() => {});
    const enrolling = promptStepUp("totp-required");
    let saved = false;
    void showBackupCodes(["aaaa-bbbb"]).then(() => {
      saved = true;
    });

    // The dialog that hosted the enrollment unmounts, taking its sheet with it.
    leave();
    expect(await enrolling).toBe(false);
    expect(heldBackupCodes()?.codes).toEqual(["aaaa-bbbb"]);
    expect(saved).toBe(false);

    heldBackupCodes()?.confirm();
    await Promise.resolve();
    expect(saved).toBe(true);
    expect(heldBackupCodes()).toBeNull();
  });

  test("a second enrollment's codes wait behind the first", () => {
    void showBackupCodes(["first"]);
    void showBackupCodes(["second"]);
    expect(heldBackupCodes()?.codes).toEqual(["first"]);
    heldBackupCodes()?.confirm();
    expect(heldBackupCodes()?.codes).toEqual(["second"]);
    heldBackupCodes()?.confirm();
  });

  test("the sheet shows nothing until codes are held", () => {
    expect(renderToStaticMarkup(<BackupCodesSheet />)).not.toContain("Backup codes");
  });
});

describe("copy", () => {
  test("one set of words per step-up, shared by the refusal, the sheet and the connect fork", () => {
    for (const reason of ["totp-required", "reauth-required"] as const) {
      const copy = failureCopy(refusal(reason));
      expect(copy).toEqual({ title: STEP_UP_COPY[reason].title, detail: STEP_UP_COPY[reason].refused });
    }
  });

  test("each step-up refusal has its own words, not the server's", () => {
    for (const reason of ["totp-required", "reauth-required"] as const) {
      const copy = failureCopy(refusal(reason));
      expect(copy.title).not.toBe("Not allowed");
      expect(copy.detail).not.toContain("server words");
    }
  });

  test("two-factor errors are bounded copy keyed on the code", () => {
    expect(twoFactorErrorMessage("INVALID_CODE")).toContain("did not match");
    expect(twoFactorErrorMessage(undefined)).toContain("did not match");
    expect(twoFactorErrorMessage("INVALID_TWO_FACTOR_COOKIE")).toContain("Start again");
    // The wait is the server's when it says, and never a number of our own.
    expect(twoFactorErrorMessage("ACCOUNT_TEMPORARILY_LOCKED")).toContain("a few minutes");
    expect(lockedMessage(2)).toContain("2 minutes");
    expect(lockedMessage(1)).toContain("1 minute,");
  });

  test("the key shown for typing is the one inside the URI", () => {
    expect(totpSecret("otpauth://totp/Eccos:a%40b.test?secret=JBSWY3DP&issuer=Eccos")).toBe("JBSWY3DP");
    expect(totpSecret("not a uri")).toBe("");
  });
});

describe("TwoFactorPanel", () => {
  test("not enrolled asks for the password; enrolled says so and offers nothing to set up", () => {
    const off = renderToStaticMarkup(<TwoFactorPanel enabled={false} />);
    expect(off).toContain("Your password");
    // The password first; the mailed code is asked for before any secret exists.
    expect(off).toContain("Email me a code");
    const on = renderToStaticMarkup(<TwoFactorPanel enabled />);
    expect(on).not.toContain("Email me a code");
    expect(on).toContain("ask for a code");
  });

  test("backup codes are listed once, with a way on and a live region for a refused copy", () => {
    const html = renderToStaticMarkup(<BackupCodes codes={["aaaa-bbbb", "cccc-dddd"]} onDone={() => {}} />);
    expect(html).toContain("aaaa-bbbb");
    expect(html).toContain("cccc-dddd");
    expect(html).toContain("Done");
    expect(html).toContain('aria-live="polite"');
  });

  test("the QR code is a labelled image, drawn upright and not mirrored across its diagonal", async () => {
    const { encode } = await import("uqr");
    const value = "otpauth://totp/Eccos:a?secret=JBSWY3DP";
    const { data } = encode(value, { border: 2 });
    // A module that is dark where its transposed twin is light tells the two apart.
    const y = data.findIndex((row, r) => row.some((on, c) => on && !data[c]![r]));
    const x = data[y]!.findIndex((on, c) => on && !data[c]![y]);
    const html = renderToStaticMarkup(<QrCode value={value} label="QR" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="QR"');
    expect(html).toContain(`M${x} ${y}h1v1h-1z`);
    expect(html).not.toContain(`M${y} ${x}h1v1h-1z`);
  });
});

describe("Settings", () => {
  test("carries the two-factor panel after the workspace's own panels", () => {
    const html = renderToStaticMarkup(<SettingsView accountId="account-a" twoFactorEnabled={false} />);
    expect(html.indexOf("Two-factor authentication")).toBeGreaterThan(html.indexOf("Account ID"));
  });
});

describe("sign-in code step", () => {
  test("starting again keeps the page the operator was going to", () => {
    const html = renderToStaticMarkup(
      <TwoFactorForm onVerified={() => {}} restartHref="/signin?redirect=%2Fwebhooks" />,
    );
    expect(html).toContain('href="/signin?redirect=%2Fwebhooks"');
  });
});
