import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { LogGrid } from "../components/grid/log-grid";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
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

const columnHelper = createColumnHelper<DataGridFeatures, TemplateItem>();

const columns = [
  columnHelper.accessor("name", {
    id: "name",
    header: "Name",
    cell: (info) => (
      <span className="font-mono text-xs">{info.getValue() ?? "\u2014"}</span>
    ),
    meta: { cellClassName: "whitespace-nowrap" },
  }),
  columnHelper.accessor("language", {
    id: "language",
    header: "Language",
    cell: (info) => info.getValue() ?? "\u2014",
    meta: { cellClassName: "whitespace-nowrap" },
  }),
  columnHelper.accessor("status", {
    id: "status",
    header: "Status",
    cell: (info) => {
      const status = info.getValue();
      return status ? <StatusTag status={status} /> : "\u2014";
    },
    meta: { cellClassName: "whitespace-nowrap" },
  }),
];

function TemplatesPage() {
  const result = Route.useLoaderData();

  if (!result.ok) {
    return (
      <Page title="Templates">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  const templates = result.data;

  if (!templates.ok) {
    const detail =
      typeof templates.error === "string"
        ? templates.error
        : JSON.stringify(templates.error, null, 2);
    return (
      <Page title="Templates">
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Failed to load templates</h2>
          <pre className={styles.errorBox}>{detail}</pre>
        </section>
      </Page>
    );
  }

  const data = (templates.data as { data?: TemplateItem[] } | null) ?? {};
  const items = data.data ?? [];
  return (
    <Page title="Templates">
      <LogGrid
        columns={columns}
        data={items}
        emptyMessage="No templates found."
        getRowId={(row, index) => `${row.name ?? "?"}-${row.language ?? index}`}
      />
    </Page>
  );
}
