/**
 * Drives `wrangler dev` for apps/mcp (port 8788) with the MCP SDK client, against the stub console
 * (tests/dev/wrangler.console.jsonc, port 8790) and the real local gateway (port 8787). Writes
 * transcripts without tokens to the directory named by EVIDENCE_DIR.
 *
 *   bun run dev:gateway &
 *   (cd apps/mcp && wrangler dev -c tests/dev/wrangler.console.jsonc --inspector-port 9241) &
 *   (cd apps/mcp && wrangler dev) &
 *   EVIDENCE_DIR=… bun apps/mcp/tests/dev/evidence.ts
 *
 * With ECCOS_ADMIN_API_KEY set, it also attaches the verify-eccos fake's WABA to the workspace and
 * drives the template tools against it (.agents/skills/verify-eccos/features/mcp.md). CONSOLE_URL
 * moves the stub console off 8790, which that stack's fake uses.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  Client,
  StreamableHTTPClientTransport,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";

const MCP = "http://localhost:8788";
const CONSOLE = process.env.CONSOLE_URL ?? "http://localhost:8790";
const GATEWAY = "http://localhost:8787";
const ADMIN_KEY = process.env.ECCOS_ADMIN_API_KEY;
const DIR = process.env.EVIDENCE_DIR ?? "evidence";
mkdirSync(DIR, { recursive: true });

const control = async (method: string, ...args: unknown[]) =>
  (
    await fetch(`${CONSOLE}/control/${method}`, {
      method: "POST",
      body: JSON.stringify(args),
    })
  ).json();

const mint = (label: string) =>
  `eyJhbGciOiJFZERTQSJ9.${btoa(JSON.stringify({ evidence: label, at: Date.now() })).replace(/=+$/, "")}.ZXZpZGVuY2U`;
const token = mint("owner");
const viewerToken = mint("viewer");
const refusedToken = mint("refused");
const otherToken = mint("other");
const redact = (text: string) =>
  (ADMIN_KEY ? text.replaceAll(ADMIN_KEY, "<admin-key>") : text)
    .replaceAll(token, "<token>")
    .replaceAll(viewerToken, "<viewer-token>")
    .replaceAll(refusedToken, "<refused-token>")
    .replaceAll(otherToken, "<other-token>");
const save = (name: string, data: unknown) => {
  writeFileSync(`${DIR}/${name}`, `${redact(JSON.stringify(data, null, 2))}\n`);
  console.log(`wrote ${DIR}/${name}`);
};
const headersOf = (response: Response) => Object.fromEntries(response.headers);

const { accountId, keyId } = (await control(
  "provision",
  "org-evidence",
  "Evidence Co",
)) as { accountId: string; keyId: string };
const actor = {
  userId: "user-evidence",
  organizationId: "org-evidence",
  accountId,
  role: "owner",
  actions: ["view", "operate", "send", "configure", "administer"],
  elevatedUntil: null,
  clientId: "evidence-client",
};
await control("reset");
await control("grant", token, {
  ok: true,
  actor,
  audience: `${MCP}/mcp`,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  scope: [
    "eccos:view",
    "eccos:operate",
    "eccos:send",
    "eccos:configure",
    "eccos:administer",
    "offline_access",
  ],
});

// 1. Challenge and discovery.
const noToken = await fetch(`${MCP}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }),
});
const unknownToken = await fetch(`${MCP}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer aaa.bbb.ccc",
  },
  body: "{}",
});
const foreignOrigin = await fetch(`${MCP}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    origin: "https://evil.example",
  },
  body: "{}",
});
const metadataResponse = await fetch(
  `${MCP}/.well-known/oauth-protected-resource/mcp`,
);
save("01-challenge-and-discovery.json", {
  noToken: {
    status: noToken.status,
    wwwAuthenticate: noToken.headers.get("www-authenticate"),
  },
  unknownToken: {
    status: unknownToken.status,
    wwwAuthenticate: unknownToken.headers.get("www-authenticate"),
  },
  foreignOrigin: {
    status: foreignOrigin.status,
    body: await foreignOrigin.text(),
  },
  metadata: {
    status: metadataResponse.status,
    headers: headersOf(metadataResponse),
    body: await metadataResponse.json(),
  },
  sdkDiscovery: await discoverOAuthProtectedResourceMetadata(`${MCP}/mcp`),
});

// 2. The SDK client on each protocol era.
for (const [label, mode] of [
  ["2026-07-28", { pin: "2026-07-28" }],
  ["2025-11-25", "legacy"],
] as const) {
  const wire: unknown[] = [];
  const tracing: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const body = request.method === "POST" ? await request.clone().text() : "";
    const response = await fetch(request);
    const text = await response.clone().text();
    const parse = (s: string) => {
      const data = s.split("\n").find((line) => line.startsWith("data:"));
      try {
        return JSON.parse(data ? data.slice(5) : s);
      } catch {
        return s;
      }
    };
    wire.push({
      request: {
        method: request.method,
        headers: Object.fromEntries(
          [...request.headers].filter(
            ([key]) => key.startsWith("mcp-") || key === "authorization",
          ),
        ),
        body: body ? parse(body) : null,
      },
      response: { status: response.status, body: text ? parse(text) : null },
    });
    return response;
  };
  const client = new Client(
    { name: `eccos-evidence-${label}`, version: "0" },
    { capabilities: {}, versionNegotiation: { mode } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), {
      authProvider: { token: async () => token },
      fetch: tracing,
    } as never),
  );
  const tools = await client.listTools();
  const workspace = await client.callTool({
    name: "workspace_get",
    arguments: {},
  });
  await client.close();
  save(`02-sdk-${label}.json`, {
    negotiatedProtocolVersion: (
      client as unknown as { getNegotiatedProtocolVersion?: () => string }
    ).getNegotiatedProtocolVersion?.(),
    tools: tools.tools.map(({ name, annotations }) => ({ name, annotations })),
    workspaceGet: workspace,
    wire,
  });
}

save("03-console-calls.json", {
  provisionedAccount: { accountId, apiKeyId: keyId },
  authorizeCalls: (
    (await control("authorizeCalls")) as { resource: string }[]
  ).map(({ resource }) => ({ resource, token: "<token>" })),
});

const grant = (bearer: string, who: Partial<typeof actor>, scope: string[]) =>
  control("grant", bearer, {
    ok: true,
    actor: { ...actor, ...who },
    audience: `${MCP}/mcp`,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    scope,
  });

const sdk = async (bearer: string) => {
  const client = new Client(
    { name: "eccos-evidence", version: "0" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), {
      authProvider: { token: async () => bearer },
    } as never),
  );
  return client;
};

// 4. A viewer: billing is never asked for, and nextTool names only tools a viewer may call.
await grant(
  viewerToken,
  { userId: "user-viewer", role: "viewer", actions: ["view"] },
  ["eccos:view"],
);
const billingBefore = ((await control("billingCalls")) as unknown[]).length;
const viewer = await sdk(viewerToken);
const viewerTools = await viewer.listTools();
const viewerWorkspace = await viewer.callTool({
  name: "workspace_get",
  arguments: {},
});
await viewer.close();
const billingAfter = (await control("billingCalls")) as unknown[];
save("04-viewer-workspace-get.json", {
  tools: viewerTools.tools.map(({ name }) => name),
  getBillingCallsDuringViewerCall: billingAfter.length - billingBefore,
  nextTools: (
    viewerWorkspace.structuredContent as {
      setup: { steps: { id: string; nextTool: unknown }[] };
    }
  ).setup.steps.map(({ id, nextTool }) => ({ id, nextTool })),
  workspaceGet: viewerWorkspace,
});

// 5. A role refusal. workspace_get is the only tool and every role holds view, so the stub
// console hands out a grant whose scope carries eccos:view while its actions do not: the shape
// a real role ∩ scope gap takes once mutating tools exist (Worker specs cover fixture_configure).
await grant(
  refusedToken,
  { userId: "user-refused", role: "viewer", actions: [] },
  ["eccos:view"],
);
const refused = await sdk(refusedToken);
const refusal = await refused.callTool({
  name: "workspace_get",
  arguments: {},
});
await refused.close();
save("05-role-refusal.json", {
  note: "The audit line is in 05-role-refusal-audit.jsonl, read from the apps/mcp wrangler dev log.",
  toolsCall: refusal,
});

// 6. Origin: a foreign port of the console's host is refused; the console origin is not.
const originCall = (origin: string) =>
  fetch(`${MCP}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      origin,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "evidence-raw",
            version: "0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
const origins: Record<string, unknown> = {};
for (const origin of [
  "http://localhost:9999",
  "https://localhost",
  "http://localhost:3000",
]) {
  const response = await originCall(origin);
  origins[origin] = {
    status: response.status,
    body: (await response.text()).slice(0, 300),
  };
}
save("06-origin.json", { consoleOrigin: "http://localhost:3000", origins });

if (ADMIN_KEY) {
  // 7. Template tools against the real gateway, with Meta answered by the verify-eccos fake.
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_KEY}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as { waba?: { status?: string } },
    };
  };
  const register = await admin("POST", `/v1/accounts/${accountId}/wabas`, {
    wabaId: "100200300",
    metaAccessToken: "fake-token",
    callbackUrl: "https://gateway.eccos-verify.example/webhooks/meta",
    phones: [{ phoneNumberId: "555001", displayPhoneNumber: "+34600000001" }],
  });
  const reconcile = await admin(
    "POST",
    `/v1/accounts/${accountId}/wabas/100200300/reconcile`,
  );
  save("07-templates-setup.json", {
    register: {
      status: register.status,
      wabaStatus: register.body?.waba?.status,
    },
    reconcile: {
      status: reconcile.status,
      wabaStatus: reconcile.body?.waba?.status,
    },
  });

  const client = await sdk(token);
  const { tools } = await client.listTools();
  const call = async (name: string, args: Record<string, unknown>) => ({
    name,
    arguments: args,
    result: await client.callTool({ name, arguments: args }),
  });
  const order = {
    to: "+34 611 111 111",
    templateName: "order_update",
    languageCode: "en_US",
  };
  const transcript = [
    await call("templates_list", {}),
    await call("template_create", {
      name: "pickup_ready",
      language: "en_US",
      category: "UTILITY",
      bodyText: "Hi {{1}}, order {{2}} is ready for pickup.",
      bodyExamples: ["Ana", "A-1042"],
      buttons: [
        {
          text: "Track",
          url: "https://shop.example/t/{{1}}",
          exampleUrl: "https://shop.example/t/A-1042",
        },
      ],
    }),
    await call("template_create", {
      name: "bad_vars",
      language: "en_US",
      category: "UTILITY",
      bodyText: "Hi {{name}}",
      bodyExamples: ["Ana"],
    }),
    await call("template_edit", {
      templateId: "900100",
      name: "order_update",
      language: "en_US",
      bodyText: "Hi {{1}}, order {{2}} shipped.",
      bodyExamples: ["Ana", "A-1"],
    }),
    await call("template_send_test", {
      ...order,
      bodyParams: ["Ana", "A-1"],
      idempotencyKey: crypto.randomUUID(),
    }),
    await call("template_send_test", { ...order, bodyParams: ["Ana"] }),
    await call("template_send_test", {
      ...order,
      to: "34600000999",
      bodyParams: ["Ana", "A-1"],
    }),
    await call("template_delete", {
      templateId: "900100",
      name: "order_update",
    }),
  ];
  await client.close();
  save("08-template-tools.json", {
    tools: tools
      .filter((tool) => tool.name.includes("template"))
      .map(({ name, annotations, inputSchema }) => ({
        name,
        annotations,
        inputSchema,
      })),
    calls: transcript,
  });

  // 8. Another workspace's agent naming this workspace's WABA and phone.
  const other = (await control("provision", "org-evidence-b", "Other Co")) as {
    accountId: string;
  };
  await grant(
    otherToken,
    {
      userId: "user-evidence-b",
      organizationId: "org-evidence-b",
      accountId: other.accountId,
    },
    ["eccos:view", "eccos:send", "eccos:configure"],
  );
  const intruder = await sdk(otherToken);
  const foreign = [
    await intruder.callTool({
      name: "templates_list",
      arguments: { wabaId: "100200300" },
    }),
    await intruder.callTool({
      name: "template_delete",
      arguments: {
        wabaId: "100200300",
        templateId: "900100",
        name: "order_update",
      },
    }),
    await intruder.callTool({
      name: "template_send_test",
      arguments: {
        phoneNumberId: "555001",
        ...order,
        bodyParams: ["Ana", "A-1"],
      },
    }),
  ];
  await intruder.close();
  save("09-two-accounts.json", {
    ownerAccount: accountId,
    otherAccount: other.accountId,
    results: foreign,
  });
}
