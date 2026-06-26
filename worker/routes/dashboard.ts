import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getConfig, getEffectiveConfig } from "../config";
import { listTemplates } from "../../src/core/templates";

type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface DashboardSnapshot {
  outbound: Array<{
    transport_message_id: string | null;
    recipient: string;
    status: string;
    error: string | null;
    created_at: number;
  }>;
  inbound: Array<{
    type: string;
    payload: string;
    received_at: number;
  }>;
  deliveries: Array<{
    id: number;
    status: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: number;
    created_at: number;
  }>;
}

export function computeHealth(snap: {
  deliveries: Array<{ status: string }>;
  outbound: Array<{ status: string }>;
}): HealthStatus {
  const failedDeliveries = snap.deliveries.filter((d) => d.status === "failed").length;
  const pendingDeliveries = snap.deliveries.filter((d) => d.status === "pending").length;
  const failedOutbound = snap.outbound.filter((o) => o.status === "failed").length;

  if (failedDeliveries > 0) return "unhealthy";
  if (pendingDeliveries > 10 || failedOutbound > 0) return "degraded";
  return "healthy";
}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString();
}

function inboundSummary(payload: string): string {
  try {
    const ev = JSON.parse(payload) as Record<string, unknown>;
    if (typeof ev.text === "string") return ev.text;
    if (typeof ev.transportMessageId === "string") return ev.transportMessageId;
    return JSON.stringify(ev).slice(0, 120);
  } catch {
    return payload.slice(0, 120);
  }
}

function healthColor(health: HealthStatus): string {
  if (health === "healthy") return "#16a34a";
  if (health === "degraded") return "#d97706";
  return "#dc2626";
}

export function renderDashboard(
  health: HealthStatus,
  snap: DashboardSnapshot,
  templates: { ok: true; data: unknown } | { ok: false; error: unknown },
  config: { displayPhone?: string; connectedAt?: string },
): string {
  const badge = `<span style="display:inline-block;padding:4px 12px;border-radius:4px;color:#fff;background:${healthColor(health)};font-weight:bold;text-transform:uppercase">${esc(health)}</span>`;
  const meta: string[] = [];
  if (config.displayPhone) meta.push(`Phone: ${esc(config.displayPhone)}`);
  if (config.connectedAt) meta.push(`Connected: ${esc(fmtTs(Number(config.connectedAt)))}`);

  const outboundRows = snap.outbound
    .map(
      (o) =>
        `<tr><td>${esc(fmtTs(o.created_at))}</td><td>${esc(o.recipient)}</td><td>${esc(o.status)}</td><td>${esc(o.transport_message_id ?? "")}</td><td>${esc(o.error ?? "")}</td></tr>`,
    )
    .join("");

  const inboundRows = snap.inbound
    .map(
      (e) =>
        `<tr><td>${esc(fmtTs(e.received_at))}</td><td>${esc(e.type)}</td><td>${esc(inboundSummary(e.payload))}</td></tr>`,
    )
    .join("");

  const deliveryRows = snap.deliveries
    .map(
      (d) =>
        `<tr><td>${d.id}</td><td>${esc(d.status)}</td><td>${d.attempts}</td><td>${esc(fmtTs(d.next_attempt_at))}</td><td>${esc(d.last_error ?? "")}</td></tr>`,
    )
    .join("");

  let templateSection: string;
  if (!templates.ok) {
    templateSection = `<p style="color:#dc2626">Failed to load templates: ${esc(String(templates.error))}</p>`;
  } else {
    const data = (templates.data as { data?: Array<{ name?: string; language?: string; status?: string }> } | null) ?? {
      data: [],
    };
    const items = data.data ?? [];
    if (items.length === 0) {
      templateSection = "<p><em>No templates found.</em></p>";
    } else {
      templateSection = `<ul>${items
        .map(
          (t) =>
            `<li><strong>${esc(t.name ?? "?")}</strong> — ${esc(t.language ?? "?")} (${esc(t.status ?? "?")})</li>`,
        )
        .join("")}</ul>`;
    }
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Eccos Dashboard</title></head>
<body style="font-family:system-ui,sans-serif;max-width:1200px;margin:0 auto;padding:16px">
<h1>Eccos Dashboard</h1>

<h2>Health</h2>
<p>${badge}${meta.length ? ` — ${meta.join(" · ")}` : ""}</p>

<h2>Outbound (50)</h2>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
<thead><tr><th>Created</th><th>Recipient</th><th>Status</th><th>Transport ID</th><th>Error</th></tr></thead>
<tbody>${outboundRows || "<tr><td colspan=\"5\"><em>None</em></td></tr>"}</tbody>
</table>

<h2>Inbound (50)</h2>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
<thead><tr><th>Received</th><th>Type</th><th>Summary</th></tr></thead>
<tbody>${inboundRows || "<tr><td colspan=\"3\"><em>None</em></td></tr>"}</tbody>
</table>

<h2>Deliveries (pending / failed)</h2>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
<thead><tr><th>ID</th><th>Status</th><th>Attempts</th><th>Next attempt</th><th>Last error</th></tr></thead>
<tbody>${deliveryRows || "<tr><td colspan=\"5\"><em>None</em></td></tr>"}</tbody>
</table>

<h2>Templates</h2>
${templateSection}

<p style="margin-top:32px;color:#666;font-size:12px">Read-only · basicAuth eccos / ECCOS_API_KEY</p>
</body></html>`;
}

export function dashboardRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.use("/dashboard", async (c, next) => {
    const cfg = getConfig(c.env);
    return basicAuth({ username: "eccos", password: cfg.ECCOS_API_KEY })(c, next);
  });

  app.get("/dashboard", async (c) => {
    const stub = c.env.ECCOS.get(c.env.ECCOS.idFromName("singleton"));
    const cfg = await getEffectiveConfig(c.env, stub);
    const snap = (await stub.snapshot()) as DashboardSnapshot;
    const templates = await listTemplates(cfg, 100);
    const health = computeHealth(snap);
    const displayPhone = (await stub.getConfigValue("DISPLAY_PHONE_NUMBER")) ?? undefined;
    const connectedAt = (await stub.getConfigValue("CONNECTED_AT")) ?? undefined;
    return c.html(renderDashboard(health, snap, templates, { displayPhone, connectedAt }));
  });

  return app;
}
