import { beforeEach, describe, expect, it } from "vitest";
import { grantToken, makeActor, postMcp, resetStubs, toolsList } from "./helpers";

beforeEach(resetStubs);

// wrangler.vitest.jsonc: 30 requests per 60 seconds per user and client.
const LIMIT = 30;

describe("rate limit", () => {
  it("answers 429 with Retry-After once one user and client exceed the limit, and no one else", async () => {
    const actor = makeActor();
    const token = await grantToken(actor);
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i++) statuses.push((await postMcp(toolsList(i), { token })).status);
    const limited = await postMcp(toolsList(), { token });
    const sameUserOtherClient = await postMcp(toolsList(), { token: await grantToken({ ...actor, clientId: "client-2" }) });
    const otherUser = await postMcp(toolsList(), { token: await grantToken(makeActor()) });

    expect(statuses).toEqual(Array(LIMIT).fill(200));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({
      error: "rate_limited",
      error_description: "Too many requests from this agent. Wait 60 seconds, then retry.",
    });
    expect(sameUserOtherClient.status).toBe(200);
    expect(otherUser.status).toBe(200);
  });
});
