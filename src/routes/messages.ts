import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Config } from "../config";
import { sendMessage } from "@eccos/core/send";

// The caller supplies a Meta message object minus `messaging_product`.
// We only require `to`; the rest (type, template, text, ...) passes through.
const bodySchema = z
  .object({ to: z.string().min(5) })
  .passthrough();

/** Authenticated send surface: POST /v1/messages. */
export function messageRoutes(db: Database, cfg: Config): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, 400);
    }

    const { to } = parsed.data;
    const now = Date.now();
    const result = await sendMessage(cfg, parsed.data);

    if (!result.ok) {
      db.query(
        `INSERT INTO outbound_messages (recipient, request, status, error, created_at)
         VALUES (?, ?, 'failed', ?, ?)`,
      ).run(to, JSON.stringify(parsed.data), JSON.stringify(result.error), now);
      return c.json({ ok: false, error: result.error }, 502);
    }

    db.query(
      `INSERT INTO outbound_messages (transport_message_id, recipient, request, status, created_at)
       VALUES (?, ?, ?, 'sent', ?)`,
    ).run(result.id, to, JSON.stringify(parsed.data), now);

    return c.json({ ok: true, messages: [{ id: result.id }] });
  });

  return app;
}
