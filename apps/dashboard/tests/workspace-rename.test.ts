/**
 * `renameWorkspace` against a real Better Auth on bun:sqlite, the same setup as
 * `workspace-select.test.ts`: only `administer` may rename the workspace the
 * page shows, only the name changes, the gateway account follows, and the slug
 * never reaches the response.
 */

import { describe, expect, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";

const BASE_URL = "http://localhost:3000";

// Mutated in place: `organizations.ts` binds `env` at import time.
const fakeEnv: { DB?: unknown; BETTER_AUTH_URL?: string; GATEWAY?: unknown } = { BETTER_AUTH_URL: BASE_URL };
let currentRequest = new Request(`${BASE_URL}/`);

installServerFnMocks({ env: fakeEnv, getRequest: () => currentRequest });

const { renameWorkspace } = await import("../src/organizations");
const { failureCopy } = await import("../src/lib/failure");
const { createAuth } = await import("../src/auth/auth");
const { CaptureMailSender } = await import("../src/auth/mail");
const { authConfigFromEnv } = await import("../src/auth/config");

async function createTestAuth() {
  const db = new Database(":memory:");
  fakeEnv.DB = db;
  const auth = createAuth({ ...authConfigFromEnv(fakeEnv as never), mail: new CaptureMailSender() });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return { auth, db };
}

async function signIn(auth: Awaited<ReturnType<typeof createTestAuth>>["auth"], db: Database, email: string) {
  await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
    }),
  );
  db.query('UPDATE user SET "emailVerified" = 1 WHERE email = ?').run(email);
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    }),
  );
  expect(res.status).toBe(200);
  return new Headers({ cookie: res.headers.get("set-cookie")!.split(";")[0]! });
}

function actAs(headers: Headers) {
  currentRequest = new Request(`${BASE_URL}/`, { headers });
}

/** Account names the fake gateway was told to store, by account id. */
let accountNames: Record<string, string> = {};
let gatewayFails = false;

/** An owner's workspace with an operator in it. */
async function workspaceWithOperator() {
  const { auth, db } = await createTestAuth();
  accountNames = {};
  gatewayFails = false;
  fakeEnv.GATEWAY = {
    getOrganizationAccountLink: async () => ({ accountId: "acc_citta", status: "active" }),
    setAccountName: async (accountId: string, name: string) => {
      if (gatewayFails) throw new Error("binding down");
      accountNames[accountId] = name;
    },
  };
  const owner = await signIn(auth, db, "owner@corp.test");
  const slug = crypto.randomUUID();
  const org = (await auth.api.createOrganization({ body: { name: "Citta", slug }, headers: owner })) as {
    id: string;
  };
  const operator = await signIn(auth, db, "operator@corp.test");
  const operatorId = (db.query("SELECT id FROM user WHERE email = ?").get("operator@corp.test") as { id: string }).id;
  await auth.api.addMember({ body: { userId: operatorId, role: "operator", organizationId: org.id } });
  const stored = () =>
    db.query("SELECT name, slug FROM organization WHERE id = ?").get(org.id) as { name: string; slug: string };
  return { auth, owner, operator, slug, stored, organizationId: org.id };
}

describe("renameWorkspace", () => {
  test("an owner renames the workspace and its gateway account; the slug stays and is never returned", async () => {
    const { owner, slug, stored, organizationId } = await workspaceWithOperator();
    actAs(owner);
    const result = await renameWorkspace({ data: { organizationId, name: "  Citta Madrid " } });
    expect(result).toEqual({ ok: true, data: { name: "Citta Madrid" } });
    expect(JSON.stringify(result)).not.toContain(slug);
    expect(stored()).toEqual({ name: "Citta Madrid", slug });
    expect(accountNames).toEqual({ acc_citta: "Citta Madrid" });
  });

  test("a rename writes an ids-only audit line, and says when the gateway did not follow", async () => {
    const { owner, organizationId } = await workspaceWithOperator();
    const lines: string[] = [];
    const info = console.info;
    console.info = (line: string) => void lines.push(line);
    try {
      actAs(owner);
      await renameWorkspace({ data: { organizationId, name: "Citta Sur" } });
      gatewayFails = true;
      await renameWorkspace({ data: { organizationId, name: "Citta Norte" } });
    } finally {
      console.info = info;
    }
    const audits = lines.map((line) => JSON.parse(line)).filter((line) => line.area === "audit");
    expect(audits).toMatchObject([
      { action: "workspace_rename", organizationId, accountId: "acc_citta", outcome: "success", detail: null },
      { action: "workspace_rename", organizationId, accountId: null, outcome: "success", detail: "gateway-name-not-synced" },
    ]);
    expect(lines.join("\n")).not.toContain("Citta Sur");
    expect(lines.join("\n")).not.toContain("Citta Norte");
  });

  test("a gateway that fails to follow does not undo the rename the user sees", async () => {
    const { owner, stored, organizationId } = await workspaceWithOperator();
    gatewayFails = true;
    actAs(owner);
    expect(await renameWorkspace({ data: { organizationId, name: "Citta Bilbao" } })).toEqual({
      ok: true,
      data: { name: "Citta Bilbao" },
    });
    expect(stored().name).toBe("Citta Bilbao");
  });

  test("an operator is refused as a missing permission, and nothing changes", async () => {
    const { operator, stored, organizationId } = await workspaceWithOperator();
    actAs(operator);
    const result = await renameWorkspace({ data: { organizationId, name: "Hijacked" } });
    expect(result).toMatchObject({ ok: false, kind: "forbidden", reason: "missing-permission" });
    expect(stored().name).toBe("Citta");
    expect(accountNames).toEqual({});
  });

  test("a session that moved to another workspace (another tab) does not rename the one it left", async () => {
    const { auth, owner, stored, organizationId } = await workspaceWithOperator();
    // Creating a workspace makes it the session's active one.
    await auth.api.createOrganization({ body: { name: "Other", slug: crypto.randomUUID() }, headers: owner });
    actAs(owner);
    const result = await renameWorkspace({ data: { organizationId, name: "Wrong tab" } });
    expect(result).toMatchObject({ ok: false, kind: "forbidden", reason: "workspace-changed" });
    expect(failureCopy(result as Parameters<typeof failureCopy>[0]).detail).toBe(
      "You switched workspace in another tab. Reload this page.",
    );
    expect(stored().name).toBe("Citta");
  });

  test("a signed-out request reads as signed out", async () => {
    const { organizationId } = await workspaceWithOperator();
    currentRequest = new Request(`${BASE_URL}/`);
    const result = await renameWorkspace({ data: { organizationId, name: "Nobody" } });
    expect(result).toMatchObject({ ok: false, kind: "unauthenticated" });
  });

  test("the schema refuses a slug, an empty name or a missing workspace before the handler runs", async () => {
    await expect(
      (async () => renameWorkspace({ data: { organizationId: "org", name: "x", slug: "taken" } as never }))(),
    ).rejects.toThrow();
    await expect((async () => renameWorkspace({ data: { organizationId: "org", name: "   " } }))()).rejects.toThrow();
    await expect((async () => renameWorkspace({ data: { name: "x" } as never }))()).rejects.toThrow();
  });
});
