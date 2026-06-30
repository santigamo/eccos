import { Hono } from "hono";
import type { Config } from "../config";
import { listTemplates } from "@eccos/core/templates";

/** Authenticated templates surface: GET /v1/templates. */
export function templateRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.get("/v1/templates", async (c) => {
    const limitParam = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 1000) : 100;
    const result = await listTemplates(cfg, limit);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
    return c.json(result.data);
  });

  return app;
}
