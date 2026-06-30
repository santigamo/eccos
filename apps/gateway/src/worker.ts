import { Hono } from "hono";
import { getConfig, getEffectiveConfig } from "./config";
import { connectRoutes } from "./routes/connect";
import { dashboardRoutes } from "./routes/dashboard";
import { constantTimeEqual, verifyMetaSignature } from "@eccos/core/signature";
import { parseMetaWebhook, parseMetaEchoes } from "@eccos/core/parser";
import { sendMessage } from "@eccos/core/send";
import { listTemplates } from "@eccos/core/templates";
import type { WhatsAppCallbackEvent } from "@eccos/core/types";

export { EccosGateway } from "./gateway";

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

app.route("/", connectRoutes());
app.route("/", dashboardRoutes());

function stub(c: { env: Bindings }) {
  return c.env.ECCOS.get(c.env.ECCOS.idFromName("singleton"));
}

app.get("/health", (c) => c.json({ ok: true, name: "eccos", version: "0.1.0" }));

app.get("/webhooks/meta", (c) => {
  const cfg = getConfig(c.env);
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === cfg.META_WEBHOOK_VERIFY_TOKEN && challenge) {
    return c.text(challenge, 200);
  }
  return c.text("Forbidden", 403);
});

app.post("/webhooks/meta", async (c) => {
  const cfg = getConfig(c.env);
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;
  if (!(await verifyMetaSignature(rawBody, signature, cfg.META_APP_SECRET))) {
    return c.json({ ok: false, error: "invalid signature" }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: "invalid json" }, 400);
  }
  const events: WhatsAppCallbackEvent[] = [...parseMetaWebhook(payload), ...parseMetaEchoes(payload)];
  const { received } = await stub(c).ingest(events);
  return c.json({ ok: true, received });
});

app.use("/v1/*", async (c, next) => {
  const cfg = getConfig(c.env);
  const auth = c.req.header("authorization");
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : c.req.header("x-api-key");
  if (!key || !constantTimeEqual(key, cfg.ECCOS_API_KEY)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const isSendRequest = c.req.method === "POST" && new URL(c.req.url).pathname === "/v1/messages";
  if (isSendRequest && c.env.SEND_RATE_LIMITER) {
    // Cloudflare Rate Limiting is per-location and eventually consistent:
    // good abuse/spike protection, not an exact global quota counter.
    const { success } = await c.env.SEND_RATE_LIMITER.limit({ key });
    if (!success) return c.json({ ok: false, error: "rate limited" }, 429);
  }
  await next();
});

app.post("/v1/messages", async (c) => {
  const cfg = await getEffectiveConfig(c.env, stub(c));
  const json = await c.req.json().catch(() => null);
  if (
    !json ||
    typeof json !== "object" ||
    typeof (json as Record<string, unknown>).to !== "string" ||
    ((json as Record<string, unknown>).to as string).length < 5
  ) {
    return c.json({ ok: false, error: "invalid body" }, 400);
  }
  const body = json as Record<string, unknown>;
  const recipient = body.to as string;
  const result = await sendMessage(cfg, body);
  if (!result.ok) {
    await stub(c).logOutbound(null, recipient, JSON.stringify(body), "failed", JSON.stringify(result.error));
    return c.json({ ok: false, error: result.error }, 502);
  }
  await stub(c).logOutbound(result.id, recipient, JSON.stringify(body), "sent", null);
  return c.json({ ok: true, messages: [{ id: result.id }] });
});

app.get("/v1/templates", async (c) => {
  const cfg = await getEffectiveConfig(c.env, stub(c));
  const n = Number(c.req.query("limit") ?? 100);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 1000) : 100;
  const result = await listTemplates(cfg, limit);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  return c.json(result.data);
});

export default app;
