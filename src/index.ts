import { Hono } from "hono";
import { loadConfig } from "./config";
import { openDb } from "./db/client";
import { webhookRoutes } from "./routes/webhooks";
import { messageRoutes } from "./routes/messages";
import { templateRoutes } from "./routes/templates";
import { startDeliveryLoop } from "./delivery/forward";
import { constantTimeEqual } from "./core/signature";

const cfg = loadConfig();
const db = openDb(cfg.DATABASE_PATH);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, name: "eccos", version: "0.1.0" }));

app.route("/", webhookRoutes(db, cfg));

app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("authorization");
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : c.req.header("x-api-key");
  if (!key || !constantTimeEqual(key, cfg.ECCOS_API_KEY)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});
app.route("/", messageRoutes(db, cfg));
app.route("/", templateRoutes(cfg));

startDeliveryLoop(db, cfg);

console.log(`[eccos] listening on :${cfg.PORT}`);

export default { port: cfg.PORT, fetch: app.fetch };
