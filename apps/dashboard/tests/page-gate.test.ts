/**
 * Anonymous auth-gate responses (eccos-myfq): a server-function call or a
 * non-HTML fetch must never be bounced to /signin, where TanStack Start would
 * answer its non-HTML Accept header with a 500.
 */

import { describe, expect, test } from "bun:test";
import { isRedirect, redirect } from "@tanstack/react-router";
import {
  acceptsHtml,
  authGate,
  isServerFnPath,
  notAcceptable,
  serverFnSignIn,
  signInRedirect,
} from "../src/auth/page-gate";

const ORIGIN = "https://app.eccos.chat";
const SERVER_FN_ACCEPT = "application/x-tss-framed, application/x-ndjson, application/json";

describe("acceptsHtml", () => {
  test("browsers and Accept-less clients take HTML", () => {
    expect(acceptsHtml("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(true);
    expect(acceptsHtml("*/*")).toBe(true);
    expect(acceptsHtml(null)).toBe(true);
  });

  test("server-function fetches and text-only crawlers do not", () => {
    expect(acceptsHtml(SERVER_FN_ACCEPT)).toBe(false);
    expect(acceptsHtml("text/plain")).toBe(false);
  });
});

describe("isServerFnPath", () => {
  test("matches the server-function base only", () => {
    expect(isServerFnPath("/_serverFn/abc")).toBe(true);
    expect(isServerFnPath("/signin")).toBe(false);
  });
});

describe("signInRedirect", () => {
  test("a page load returns to that page", () => {
    const res = signInRedirect(new Request(`${ORIGIN}/numbers?wabaId=1`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin?redirect=%2Fnumbers%3FwabaId%3D1");
  });

  test("a non-page path gets a bare /signin", () => {
    const res = signInRedirect(new Request(`${ORIGIN}/robots.txt`));
    expect(res.headers.get("location")).toBe("/signin");
  });
});

describe("serverFnSignIn", () => {
  async function clientRedirect(res: Response) {
    // What the TanStack Start client fetcher does with a JSON response
    // (router-core `parseRedirect`, not re-exported by react-router).
    const body = await res.json();
    expect(body.isSerializedRedirect).toBe(true);
    const thrown = redirect(body);
    expect(isRedirect(thrown)).toBe(true);
    return thrown.options;
  }

  test("redirects the calling page, not the server function, with a full load", async () => {
    const res = serverFnSignIn(
      new Request(`${ORIGIN}/_serverFn/abc?payload=x`, {
        headers: { accept: SERVER_FN_ACCEPT, referer: `${ORIGIN}/templates?wabaId=1` },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const options = await clientRedirect(res);
    expect(options.href).toBe("/signin?redirect=%2Ftemplates%3FwabaId%3D1");
    expect(options.reloadDocument).toBe(true);
  });

  test("ignores a cross-origin or missing Referer", async () => {
    const foreign = serverFnSignIn(
      new Request(`${ORIGIN}/_serverFn/abc`, { headers: { referer: "https://evil.example/numbers" } }),
    );
    expect((await clientRedirect(foreign)).href).toBe("/signin");
    const none = serverFnSignIn(new Request(`${ORIGIN}/_serverFn/abc`));
    expect((await clientRedirect(none)).href).toBe("/signin");
  });
});

test("notAcceptable answers 406, not 500", () => {
  expect(notAcceptable().status).toBe(406);
});

describe("authGate order", () => {
  const anonymous = async () => false;
  const signedIn = async () => true;
  const never = async (): Promise<boolean> => {
    throw new Error("the session must not be read");
  };
  const req = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, { headers });

  test("static assets pass before anything else, even for a non-HTML Accept", async () => {
    expect(await authGate(req("/assets/app.js", { accept: "text/plain" }), never)).toBeUndefined();
  });

  test("a non-HTML page request gets a 406 before the session is read", async () => {
    const res = await authGate(req("/numbers", { accept: "text/plain" }), never);
    expect(res?.status).toBe(406);
    expect((await authGate(req("/signin", { accept: "application/json" }), never))?.status).toBe(406);
  });

  test("an anonymous server-function call gets the serialized 401, not the 406 or the 302", async () => {
    const res = await authGate(req("/_serverFn/abc", { accept: SERVER_FN_ACCEPT }), anonymous);
    expect(res?.status).toBe(401);
  });

  test("an anonymous page load gets the 302; a public page passes", async () => {
    const res = await authGate(req("/numbers"), anonymous);
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe("/signin?redirect=%2Fnumbers");
    expect(await authGate(req("/reset-password?token=t"), anonymous)).toBeUndefined();
  });

  test("a signed-in user passes, and is bounced off the auth pages except /reset-password", async () => {
    expect(await authGate(req("/_serverFn/abc", { accept: SERVER_FN_ACCEPT }), signedIn)).toBeUndefined();
    expect(await authGate(req("/numbers"), signedIn)).toBeUndefined();
    expect((await authGate(req("/signin"), signedIn))?.headers.get("location")).toBe("/");
    expect(await authGate(req("/reset-password?token=t"), signedIn)).toBeUndefined();
  });
});
