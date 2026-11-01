/**
 * Anonymous auth-gate responses (eccos-myfq): a server-function call or a
 * non-HTML fetch must never be bounced to /signin, where TanStack Start would
 * answer its non-HTML Accept header with a 500.
 */

import { describe, expect, test } from "bun:test";
import { isRedirect, redirect } from "@tanstack/react-router";
import {
  acceptsHtml,
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
