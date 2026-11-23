// Local stand-in for the three external systems Eccos talks to, so the stack runs
// without real credentials: Meta's Graph API (/graph), a subscriber webhook
// (/subscriber) and the transactional mail provider (/mail). Every request is
// appended to a JSONL log, which is the evidence for outbound side effects.
// Usage: bun fake-meta.ts <port> <log-file>
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2]);
const logFile = process.argv[3];
if (!port || !logFile) {
  console.error("usage: bun fake-meta.ts <port> <log-file>");
  process.exit(2);
}

/** Sending to this number makes the fake answer like Meta does for an undeliverable recipient. */
const UNDELIVERABLE = "34600000999";
const WABA_ID = "100200300";
const PHONE = { id: "555001", display_phone_number: "+34 600 000 001", verified_name: "Eccos Verify" };
const TEMPLATE = {
  id: "900100",
  name: "order_update",
  language: "en_US",
  status: "APPROVED",
  category: "UTILITY",
  components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} is on its way.", example: { body_text: [["Ana", "A-1"]] } }],
};

let sent = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function metaError(status: number, code: number, message: string): Response {
  return json({ error: { message, type: "OAuthException", code, fbtrace_id: "FAKE" } }, status);
}

function graph(method: string, path: string, query: URLSearchParams, body: string): Response | null {
  const segments = path.split("/").filter(Boolean).slice(1);
  const [first, edge] = segments;
  if (first === "oauth" && edge === "access_token") return json({ access_token: "fake-business-token" });
  if (first === "debug_token") {
    return json({
      data: {
        app_id: "verify-app-id",
        type: "SYSTEM_USER",
        is_valid: true,
        expires_at: 0,
        scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: [WABA_ID] },
          { scope: "whatsapp_business_messaging", target_ids: [WABA_ID] },
        ],
      },
    });
  }
  if (edge === "phone_numbers" && method === "GET") return json({ data: [PHONE] });
  if (edge === "subscribed_apps") {
    if (method === "GET") return json({ data: [{ whatsapp_business_api_data: { id: "verify-app-id", name: "Eccos Verify" } }] });
    return json({ success: true });
  }
  if (edge === "message_templates") {
    if (method === "GET") return json({ data: [TEMPLATE], paging: {} });
    if (method === "POST") return json({ id: "900101", status: "PENDING", category: "UTILITY" });
    if (method === "DELETE") return json({ success: true });
  }
  if (edge === "messages" && method === "POST") {
    const to = (JSON.parse(body) as { to?: string }).to ?? "";
    if (to === UNDELIVERABLE) return metaError(400, 131026, "Message undeliverable");
    sent += 1;
    return json({
      messaging_product: "whatsapp",
      contacts: [{ input: to, wa_id: to }],
      messages: [{ id: `wamid.FAKE${sent}` }],
    });
  }
  if (first === PHONE.id && edge === undefined && method === "GET" && query.has("fields")) {
    return json({ id: PHONE.id, is_on_biz_app: false, platform_type: "CLOUD_API" });
  }
  return null;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    let response: Response;
    let handled = true;
    if (url.pathname === "/__health") return json({ ok: true, name: "eccos-verify-fake" });
    if (url.pathname.startsWith("/graph/")) {
      const answer = graph(request.method, url.pathname.slice("/graph".length), url.searchParams, body);
      handled = answer !== null;
      response = answer ?? metaError(400, 100, `fake-meta has no answer for ${request.method} ${url.pathname}`);
    } else if (url.pathname.startsWith("/subscriber/") || url.pathname.startsWith("/mail/")) {
      response = json({ ok: true, id: crypto.randomUUID() });
    } else {
      handled = false;
      response = json({ error: "not found" }, 404);
    }
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "x-eccos-signature", "idempotency-key"]) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    appendFileSync(
      logFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method: request.method,
        path: url.pathname,
        query: url.search.replace(/(access_token|client_secret|input_token)=[^&]*/g, "$1=<redacted>"),
        headers,
        body,
        status: response.status,
        handled,
      })}\n`,
    );
    return response;
  },
});
console.log(`eccos-verify-fake listening on http://127.0.0.1:${port}`);
