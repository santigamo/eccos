import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_SCOPES,
  METADATA_URL,
  RESOURCE,
  consoleStub,
  fetcher,
  grantToken,
  makeActor,
  newToken,
  postMcp,
  resetStubs,
  toolsList,
} from "./helpers";

const AGENT_SCOPES = ALL_SCOPES.filter((scope) => scope !== "offline_access");

beforeEach(resetStubs);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

describe("unauthenticated requests", () => {
  it("challenges a request without a token and never asks the console", async () => {
    const response = await postMcp(toolsList());

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(challenge).toContain(`scope="${AGENT_SCOPES.join(" ")}"`);
    expect(await consoleStub.authorizeCalls()).toEqual([]);
  });

  it("publishes RFC 9728 metadata naming the console issuer", async () => {
    const response = await fetcher()(METADATA_URL);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: ["https://console.example.test"],
      scopes_supported: AGENT_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  it.each([
    ["no scheme", "abc.def.ghi"],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["an empty bearer", "Bearer "],
    ["two values", "Bearer a.b.c d.e.f"],
    ["not a JWT", "Bearer opaque-token"],
    ["two segments", "Bearer abc.def"],
    ["characters outside base64url", "Bearer abc.d$f.ghi"],
  ])("refuses %s without calling authorize", async (_label, authorization) => {
    const response = await postMcp(toolsList(), { headers: { authorization } });

    expect(response.status).toBe(401);
    expect(await consoleStub.authorizeCalls()).toEqual([]);
  });

  it("does not serve the retired SSE transport", async () => {
    const actor = makeActor();
    const token = await grantToken(actor);
    const response = await fetcher()("https://mcp.example.test/sse", { headers: { authorization: `Bearer ${token}` } });

    expect(response.status).toBe(404);
  });
});

describe("authorization on every request", () => {
  it("answers every refusal code with the same 401", async () => {
    const codes = ["invalid_token", "revoked", "not_a_member", "no_account"] as const;
    const responses = [];
    for (const code of codes) {
      const token = newToken();
      await consoleStub.grant(token, { ok: false, code });
      responses.push(await snapshot(await postMcp(toolsList(), { token })));
    }
    const unknown = await snapshot(await postMcp(toolsList(), { token: newToken() }));

    expect(responses[0]?.status).toBe(401);
    expect(responses[0]?.headers).toContainEqual([
      "www-authenticate",
      `Bearer realm="OAuth", resource_metadata="${METADATA_URL}", error="invalid_token", scope="${AGENT_SCOPES.join(" ")}"`,
    ]);
    for (const response of [...responses.slice(1), unknown]) expect(response).toEqual(responses[0]);
  });

  it("refuses a token whose audience is another resource", async () => {
    const actor = makeActor();
    const token = newToken();
    await consoleStub.grant(token, {
      ok: true,
      actor,
      audience: "https://other.example.test/mcp",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      scope: ALL_SCOPES,
    });

    expect((await postMcp(toolsList(), { token })).status).toBe(401);
  });

  it("passes the canonical resource and the token to authorize", async () => {
    const token = await grantToken(makeActor());
    await postMcp(toolsList(), { token });

    expect(await consoleStub.authorizeCalls()).toEqual([{ resource: RESOURCE, token }]);
  });

  it("asks the console again on every request", async () => {
    const token = await grantToken(makeActor());

    expect((await postMcp(toolsList(1), { token })).status).toBe(200);
    expect((await postMcp(toolsList(2), { token })).status).toBe(200);
    expect(await consoleStub.authorizeCalls()).toHaveLength(2);
  });

  it("refuses the next request once the console refuses the grant", async () => {
    const token = await grantToken(makeActor());

    expect((await postMcp(toolsList(1), { token })).status).toBe(200);
    await consoleStub.revoke(token);
    const second = await postMcp(toolsList(2), { token });

    expect(second.status).toBe(401);
    expect(second.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});
