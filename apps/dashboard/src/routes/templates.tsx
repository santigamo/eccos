import { createFileRoute } from "@tanstack/react-router";
import { listTemplates } from "../server/gateway";
import { Page, StatusTag, Unreachable, styles } from "../ui";

export const Route = createFileRoute("/templates")({
  loader: () => listTemplates(),
  component: TemplatesPage,
});

interface TemplateItem {
  name?: string;
  language?: string;
  status?: string;
}

function TemplatesPage() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <Page title="Templates">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  // Second layer: the gateway was reachable but the Meta templates fetch failed.
  const templates = result.data;
  if (!templates.ok) {
    const detail =
      typeof templates.error === "string"
        ? templates.error
        : JSON.stringify(templates.error, null, 2);
    return (
      <Page title="Templates">
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Failed to load templates</h2>
          <pre style={styles.errorBox}>{detail}</pre>
        </section>
      </Page>
    );
  }

  const data = (templates.data as { data?: TemplateItem[] } | null) ?? {};
  const items = data.data ?? [];
  return (
    <Page title="Templates">
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Language</th>
              <th style={styles.th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td style={styles.empty} colSpan={3}>
                  No templates found.
                </td>
              </tr>
            ) : (
              items.map((t, i) => (
                <tr key={`${t.name ?? "?"}-${t.language ?? i}`}>
                  <td style={styles.tdMono}>{t.name ?? "—"}</td>
                  <td style={styles.td}>{t.language ?? "—"}</td>
                  <td style={styles.td}>
                    {t.status ? <StatusTag status={t.status} /> : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
