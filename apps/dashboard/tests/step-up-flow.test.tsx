/**
 * The operator's side of step-up (eccos-eyel): a refused sensitive action
 * leads to enrollment or a fresh sign-in and back, never to a dead end.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { safeRedirectTarget } from "../src/auth/redirect-target";
import { failureCopy } from "../src/lib/failure";
import { totpSecret, twoFactorErrorMessage } from "../src/lib/two-factor";
import type { Failure } from "../src/server/gateway";

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const { followStepUp, stepUpHref } = await import("../src/lib/step-up");
const { BackupCodes, TwoFactorPanel } = await import("../src/components/dashboard/two-factor");
const { QrCode } = await import("../src/components/dashboard/qr-code");
const { SettingsView } = await import("../src/routes/settings");
const { LoginForm } = await import("../src/components/blocks/auth-13/components/login-form");

const refusal = (reason: Failure["reason"]): Failure => ({
  ok: false,
  kind: "forbidden",
  reason,
  error: "server words",
});

/** Every page that hosts a step-up action. */
const ORIGINS = ["/settings", "/numbers", "/numbers/attach-token", "/webhooks?wabaId=100"];

describe("stepUpHref", () => {
  test("enrollment and re-authentication each carry the way back", () => {
    expect(stepUpHref("totp-required", "/numbers")).toBe("/settings?redirect=%2Fnumbers");
    expect(stepUpHref("reauth-required", "/webhooks?wabaId=100")).toBe(
      "/signin?reauth=1&redirect=%2Fwebhooks%3FwabaId%3D100",
    );
  });

  test("the way back survives the destination's own redirect validation", () => {
    for (const origin of ORIGINS) {
      for (const reason of ["totp-required", "reauth-required"] as const) {
        const href = new URL(stepUpHref(reason, origin)!, "http://localhost");
        expect(safeRedirectTarget(href.searchParams.get("redirect") ?? undefined)).toBe(origin);
      }
    }
  });

  test("no other refusal is a step-up", () => {
    expect(stepUpHref("missing-permission", "/settings")).toBeNull();
    expect(stepUpHref(undefined, "/settings")).toBeNull();
  });
});

describe("followStepUp", () => {
  function nav() {
    const log: string[] = [];
    return {
      log,
      here: () => "/settings",
      assign: (href: string) => void log.push(href),
      signOut: async () => void log.push("signed out"),
    };
  }

  test("missing TOTP goes straight to enrollment, still signed in", () => {
    const n = nav();
    expect(followStepUp(refusal("totp-required"), n)).toBe(true);
    expect(n.log).toEqual(["/settings?redirect=%2Fsettings"]);
  });

  test("a stale session is ended before the sign-in page, which would bounce it", async () => {
    const n = nav();
    expect(followStepUp(refusal("reauth-required"), n)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(n.log).toEqual(["signed out", "/signin?reauth=1&redirect=%2Fsettings"]);
  });

  test("a failed sign-out still navigates", async () => {
    const n = nav();
    n.signOut = () => Promise.reject(new Error("offline"));
    followStepUp(refusal("reauth-required"), n);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(n.log).toEqual(["/signin?reauth=1&redirect=%2Fsettings"]);
  });

  test("any other failure is left to the caller", () => {
    const n = nav();
    expect(followStepUp(refusal("missing-permission"), n)).toBe(false);
    expect(followStepUp({ ok: false, kind: "unreachable", error: "x" }, n)).toBe(false);
    expect(n.log).toEqual([]);
  });
});

describe("copy", () => {
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
    expect(twoFactorErrorMessage("ACCOUNT_TEMPORARILY_LOCKED")).toContain("15 minutes");
  });

  test("the key shown for typing is the one inside the URI", () => {
    expect(totpSecret("otpauth://totp/Eccos:a%40b.test?secret=JBSWY3DP&issuer=Eccos")).toBe("JBSWY3DP");
    expect(totpSecret("not a uri")).toBe("");
  });
});

describe("TwoFactorPanel", () => {
  test("not enrolled: asks for the password, and says why when sent here", () => {
    const sent = renderToStaticMarkup(<TwoFactorPanel enabled={false} returnTo="/numbers" />);
    expect(sent).toContain("The action you started needs two-factor authentication");
    expect(sent).toContain("Your password");
    expect(sent).toContain("Set up");
    const visiting = renderToStaticMarkup(<TwoFactorPanel enabled={false} />);
    expect(visiting).not.toContain("The action you started");
    expect(visiting).toContain("Set up");
  });

  test("enrolled: says so, and offers the way back when there is one", () => {
    const html = renderToStaticMarkup(<TwoFactorPanel enabled returnTo="/numbers" />);
    expect(html).not.toContain("Set up");
    expect(html).toContain('href="/numbers"');
    expect(renderToStaticMarkup(<TwoFactorPanel enabled />)).not.toContain("Back to where you were");
  });

  test("backup codes are listed once with the way onward", () => {
    const html = renderToStaticMarkup(<BackupCodes codes={["aaaa-bbbb", "cccc-dddd"]} doneHref="/numbers" />);
    expect(html).toContain("aaaa-bbbb");
    expect(html).toContain("cccc-dddd");
    expect(html).toContain('href="/numbers"');
    expect(html).toContain("Continue");
  });

  test("the QR code draws the URI as a labelled image", () => {
    const html = renderToStaticMarkup(<QrCode value="otpauth://totp/Eccos:a?secret=JBSWY3DP" label="QR" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="QR"');
    expect(html).toMatch(/<path d="M\d+ \d+h1v1h-1z/);
  });
});

describe("Settings", () => {
  test("the panel leads the page when it is why the operator is here", () => {
    const sent = renderToStaticMarkup(
      <SettingsView accountId="account-a" twoFactorEnabled={false} returnTo="/numbers" />,
    );
    expect(sent.indexOf("Two-factor authentication")).toBeLessThan(sent.indexOf("Account ID"));
    const visiting = renderToStaticMarkup(<SettingsView accountId="account-a" twoFactorEnabled={false} />);
    expect(visiting.indexOf("Two-factor authentication")).toBeGreaterThan(visiting.indexOf("Account ID"));
  });
});

describe("sign-in", () => {
  test("a re-authentication says why the operator is being asked again", () => {
    const form = (notice: string | null) =>
      renderToStaticMarkup(
        <LoginForm
          onSubmit={() => {}}
          notice={notice}
          error={null}
          pending={false}
          email=""
          password=""
          onEmailChange={() => {}}
          onPasswordChange={() => {}}
        />,
      );
    expect(form("Confirm it's you.")).toContain("Confirm it&#x27;s you.");
    expect(form(null)).not.toContain("Confirm");
  });
});
