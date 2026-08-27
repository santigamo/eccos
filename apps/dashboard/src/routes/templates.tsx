import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { GridEmptyState } from "../components/grid/empty-state";
import { LogGrid } from "../components/grid/log-grid";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { listTemplates } from "../server/gateway";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import { Page, StatusTag, Unreachable } from "../ui";

export const Route = createFileRoute("/templates")({
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => listTemplates({ data: { wabaId: deps.wabaId } }),
  component: TemplatesPage,
});

interface TemplateItem {
  id?: string;
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
      <Page title="Templates" kicker="Cloud API">
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
      <Page title="Templates" kicker="Cloud API">
        <Frame variant="default" spacing="sm">
          <FramePanel fit>
            <FrameHeader>
              <FrameTitle>Failed to load templates</FrameTitle>
              <FrameDescription>
                The gateway returned an error while loading message templates.
              </FrameDescription>
            </FrameHeader>
            <pre className="mt-2 overflow-auto border border-destructive/20 bg-destructive/10 p-3 text-destructive text-xs whitespace-pre-wrap break-words">
              {detail}
            </pre>
          </FramePanel>
        </Frame>
      </Page>
    );
  }

  const payload = templates.data;
  const items =
    typeof payload === "object" &&
    payload !== null &&
    "data" in payload &&
    Array.isArray(payload.data)
      ? (payload.data as TemplateItem[])
      : [];
  return (
    <Page title="Templates" kicker="Cloud API">
      <LogGrid
        columns={columns}
        data={items}
        emptyMessage={
          <GridEmptyState
            label="NO TEMPLATES"
            description="Message templates approved for this WABA will appear here."
          />
        }
        getRowId={(row) => row.id ?? `${row.name ?? "?"}-${row.language ?? "?"}`}
      />
    </Page>
  );
}
