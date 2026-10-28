/**
 * The media route (`/media/<wabaId>/<mediaId>`): session and workspace checks,
 * the not-found shape for another workspace's media, and the streaming headers.
 */

import { describe, expect, test } from "bun:test";
import type { GatewayApi, MediaObject } from "@eccos/gateway-contract";
import { UnauthorizedError } from "../src/auth/session";
import { ForbiddenError } from "../src/auth/tenant";
import { dispositionFor, MEDIA_ROUTE, serveMedia, type MediaRouteDeps } from "../src/server/media";

const WABA_A = "WABA_A";
const WABA_B = "WABA_B";
const MEDIA_ID = "5550001";
const BYTES = "fake-image-bytes";

function bodyOf(bytes: string, contentType: string): MediaObject {
  return {
    body: new Response(bytes).body!,
    contentType,
    size: bytes.length,
  };
}

interface FakeWorld {
  /** Organization → account link, as the control plane reports it. */
  links: Record<string, { accountId: string; status: "active" | "pending" | "disabled" }>;
  /** Account → the WABAs it owns. */
  wabas: Record<string, string[]>;
  /** What getMedia returns for the call, keyed by `${wabaId}/${mediaId}`. */
  media: Record<string, MediaObject>;
  /** When set, getMedia throws this (a transport failure). */
  failure?: Error;
}

function fakeGateway(world: FakeWorld) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const gateway = {
    async getOrganizationAccountLink(organizationId: string) {
      calls.push({ method: "getOrganizationAccountLink", args: [organizationId] });
      return world.links[organizationId] ?? null;
    },
    async listAccountResources(accountId: string) {
      calls.push({ method: "listAccountResources", args: [accountId] });
      const wabas = (world.wabas[accountId] ?? []).map((wabaId) => ({ wabaId }));
      return { account: { accountId }, keys: [], wabas, phones: [] };
    },
    async getMedia(input: { wabaId: string; mediaId: string }, accountId: string) {
      calls.push({ method: "getMedia", args: [input, accountId] });
      if (world.failure) throw world.failure;
      return world.media[`${input.wabaId}/${input.mediaId}`] ?? null;
    },
  };
  return { gateway: gateway as unknown as GatewayApi, calls };
}

function deps(organizationFor: MediaRouteDeps["organizationFor"], world: FakeWorld): MediaRouteDeps & { calls: ReturnType<typeof fakeGateway>["calls"] } {
  const { gateway, calls } = fakeGateway(world);
  return { organizationFor, gateway, calls };
}

const member = async () => "org-a";

function request(method = "GET"): Request {
  return new Request(`https://app.eccos.chat/media/${WABA_A}/${MEDIA_ID}`, { method });
}

const ownWorld = (): FakeWorld => ({
  links: { "org-a": { accountId: "acct-a", status: "active" }, "org-b": { accountId: "acct-b", status: "active" } },
  wabas: { "acct-a": [WABA_A], "acct-b": [WABA_B] },
  media: { [`${WABA_A}/${MEDIA_ID}`]: bodyOf(BYTES, "image/jpeg") },
});

describe("media route: session and workspace checks", () => {
  test("no session is 401, with no gateway call", async () => {
    const d = deps(async () => {
      throw new UnauthorizedError();
    }, ownWorld());

    const response = await serveMedia(request(), d, WABA_A, MEDIA_ID);

    expect(response.status).toBe(401);
    expect(d.calls).toEqual([]);
  });

  test("a signed-in user with no workspace membership is 403", async () => {
    const d = deps(async () => {
      throw new ForbiddenError("no organization membership", "no-organization");
    }, ownWorld());

    expect((await serveMedia(request(), d, WABA_A, MEDIA_ID)).status).toBe(403);
  });

  test("another workspace's WABA is 404, and its bytes are never read", async () => {
    const d = deps(async () => "org-b", ownWorld());

    const response = await serveMedia(request(), d, WABA_A, MEDIA_ID);

    expect(response.status).toBe(404);
    expect(d.calls.map((call) => call.method)).not.toContain("getMedia");
  });

  test("an organization with no active account link is 404", async () => {
    const world = ownWorld();
    world.links = { "org-a": { accountId: "acct-a", status: "pending" } };
    const d = deps(member, world);

    expect((await serveMedia(request(), d, WABA_A, MEDIA_ID)).status).toBe(404);
  });

  test("an unknown media id in the caller's own WABA is 404", async () => {
    const d = deps(member, ownWorld());

    expect((await serveMedia(request(), d, WABA_A, "9999999")).status).toBe(404);
  });

  test("a gateway that cannot be reached is 503, not a claim about the media", async () => {
    const world = ownWorld();
    world.failure = new Error("service binding unavailable");

    expect((await serveMedia(request(), deps(member, world), WABA_A, MEDIA_ID)).status).toBe(503);
  });

  test("only GET is served", async () => {
    const response = await serveMedia(request("POST"), deps(member, ownWorld()), WABA_A, MEDIA_ID);
    expect(response.status).toBe(405);
  });
});

describe("media route: streaming headers", () => {
  test("streams the bytes with the stored type, a private cache, and a sandboxed policy", async () => {
    const response = await serveMedia(request(), deps(member, ownWorld()), WABA_A, MEDIA_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(BYTES.length));
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await response.text()).toBe(BYTES);
  });

  test("looks the media up in the caller's own account, never a client-named one", async () => {
    const d = deps(member, ownWorld());
    await serveMedia(request(), d, WABA_A, MEDIA_ID);
    expect(d.calls.find((call) => call.method === "getMedia")?.args[1]).toBe("acct-a");
  });

  test("audio and video play inline; documents download", () => {
    expect(dispositionFor("audio/ogg; codecs=opus")).toBe("inline");
    expect(dispositionFor("video/mp4")).toBe("inline");
    expect(dispositionFor("image/webp")).toBe("inline");
    expect(dispositionFor("application/pdf")).toBe("attachment");
    expect(dispositionFor("text/html")).toBe("attachment");
  });
});

describe("media route path", () => {
  test("matches only the WABA and media id shapes the inbox links to", () => {
    expect(MEDIA_ROUTE.exec(`/media/${WABA_A}/${MEDIA_ID}`)?.slice(1)).toEqual([WABA_A, MEDIA_ID]);
    expect(MEDIA_ROUTE.exec("/media/WABA_A/abc")).toBeNull();
    expect(MEDIA_ROUTE.exec("/media/../secret/1")).toBeNull();
    expect(MEDIA_ROUTE.exec("/media/WABA_A/1/2")).toBeNull();
    expect(MEDIA_ROUTE.exec("/messages/WABA_A/1")).toBeNull();
  });
});
