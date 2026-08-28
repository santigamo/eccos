import { describe, expect, test } from "bun:test";
import { dashboardInstallationKey, enforceAccess } from "../src/access";

// Isolated Bun unit check for the Access gate. Not wired into the root
// `bun run test` / `bun run test:workers` scripts (those stay scoped to the
// gateway); run with `cd apps/dashboard && bun run test`. `tests/` is outside the
// dashboard tsconfig `include`, so this file never affects `tsc --noEmit`.
const localReq = () => new Request("http://localhost/");
const publicReq = () => new Request("https://dashboard.example/");

describe("enforceAccess", () => {
  test("allows (returns null) when both ACCESS_* are unset — local dev, no gate", async () => {
    expect(await enforceAccess(localReq(), {})).toBeNull();
  });

  test("fails closed when only one of the two vars is configured", async () => {
    expect(
      (await enforceAccess(publicReq(), { ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com" }))?.status,
    ).toBe(403);
    expect((await enforceAccess(publicReq(), { ACCESS_AUD: "aud-tag" }))?.status).toBe(403);
  });

  test("treats empty-string vars as local development only", async () => {
    expect(await enforceAccess(localReq(), { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" })).toBeNull();
    expect((await enforceAccess(publicReq(), { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }))?.status).toBe(403);
  });

  test("fails closed for a public deployment when Access is not configured", async () => {
    const res = await enforceAccess(publicReq(), {});
    expect(res?.status).toBe(403);
  });

  test("fails closed with 403 when configured but no Access JWT is present", async () => {
    const res = await enforceAccess(publicReq(), {
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

describe("dashboardInstallationKey", () => {
  test("uses a stable local identity without Access configuration", () => {
    expect(dashboardInstallationKey({})).toBe("local:v1");
  });

  test("derives the identity from the Access application, not a user", () => {
    expect(
      dashboardInstallationKey({ ACCESS_TEAM_DOMAIN: "HTTPS://MyTeam.CloudflareAccess.com/", ACCESS_AUD: "aud-tag" }),
    ).toBe("access:v1:myteam.cloudflareaccess.com:aud-tag");
  });

  test("rejects partial Access configuration", () => {
    expect(() => dashboardInstallationKey({ ACCESS_AUD: "aud-tag" })).toThrow(/both be configured/);
  });
});
