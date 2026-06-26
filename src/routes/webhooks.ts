import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "../config";
import { verifyMetaSignature } from "../core/signature";
import { parseMetaWebhook } from "../core/parser";
import { enqueueDelivery, processPending } from "../delivery/forward";

/** Public Meta webhook routes (authenticated by signature, not API key). */
export function webhookRoutes(db: Database, cfg: Config): Hono {
  const app = new Hono();

  app.get("/webhooks/meta", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && token === cfg.META_WEBHOOK_VERIFY_TOKEN && challenge) {
      return c.text(challenge, 200);
    }
    return c.text("Forbidden", 403);
  });

  app.post("/webhooks/meta", async (c) => {
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

    const events = parseMetaWebhook(payload);
    if (events.length > 0) {
      const now = Date.now();
      const insert = db.query(
        `INSERT INTO inbound_events (type, payload, received_at) VALUES (?, ?, ?)`,
      );
      for (const event of events) {
        insert.run(event.type, JSON.stringify(event), now);
      }
      enqueueDelivery(db, events);
      void processPending(db, cfg);
    }

    return c.json({ ok: true, received: events.length });
  });

  return app;
}
