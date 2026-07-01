import { describe, expect, test } from "bun:test";
import { enforceAccess } from "../src/access";

// Isolated Bun unit check for the Access gate. Not wired into the root
// `bun run test` / `bun run test:workers` scripts (those stay scoped to the
// gateway); run with `cd apps/dashboard && bun run test`. `tests/` is outside the
// dashboard tsconfig `include`, so this file never affects `tsc --noEmit`.
const req = () => new Request("https://dashboard.example/");

describe("enforceAccess", () => {
  test("allows (returns null) when both ACCESS_* are unset — local dev, no gate", async () => {
    expect(await enforceAccess(req(), {})).toBeNull();
  });

  test("allows when only one of the two vars is configured (still not enforcing)", async () => {
    expect(
      await enforceAccess(req(), { ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com" }),
    ).toBeNull();
    expect(await enforceAccess(req(), { ACCESS_AUD: "aud-tag" })).toBeNull();
  });

  test("treats empty-string vars as unset (empty = disabled)", async () => {
    expect(
      await enforceAccess(req(), { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }),
    ).toBeNull();
  });

  test("fails closed with 403 when configured but no Access JWT is present", async () => {
    const res = await enforceAccess(req(), {
      ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag-123",
    });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect(await res?.text()).toBe("Forbidden");
  });

  test("fails closed with 403 when the presented JWT is not a valid Access token", async () => {
    const request = new Request("https://dashboard.example/", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-real-jwt" },
    });
    const res = await enforceAccess(request, {
      ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag-123",
    });
    expect(res?.status).toBe(403);
  });
});
