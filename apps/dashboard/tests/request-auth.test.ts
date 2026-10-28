/** One Better Auth instance per Request; nothing shared across Requests. */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getAuthForRequest } from "../src/auth/request-auth";
import { beginTiming, finishTiming } from "../src/server/timing";

const env = { DB: new Database(":memory:") as unknown as D1Database,BETTER_AUTH_SECRET: "test-secret-32-chars-minimum-length!!" };
const req = () => new Request("http://localhost:3000/");

describe("getAuthForRequest", () => {
  test("returns the same instance for the same request (Request or Headers)", () => {
    const request = req();
    const first = getAuthForRequest(request, env);
    expect(getAuthForRequest(request, env)).toBe(first);
    expect(getAuthForRequest(request.headers, env)).toBe(first);
  });

  test("never shares an instance across requests", () => {
    expect(getAuthForRequest(req(), env)).not.toBe(getAuthForRequest(req(), env));
  });

  test("builds a fresh instance when there is no request", () => {
    expect(getAuthForRequest(undefined, env)).not.toBe(getAuthForRequest(undefined, env));
  });

  test("counts exactly one auth instance per request in Server-Timing", () => {
    const request = req();
    beginTiming(request);
    getAuthForRequest(request, env);
    getAuthForRequest(request, env);
    getAuthForRequest(request, env);
    const report = finishTiming(request)!;
    expect(report.header).toContain("auth-instances;dur=0");
    expect(report.counts["auth-instances"]).toBeUndefined();
  });
});
