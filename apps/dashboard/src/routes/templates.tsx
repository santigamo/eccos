import { useState } from "react";
import { createFileRoute, useLoaderData } from "@tanstack/react-router";
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
import { Page, StatusTag } from "../ui";
import { FailureView } from "../components/dashboard/failure";
import { Button } from "@/components/ui/button";
import { analyzeTemplate, canSendTemplate } from "../lib/template-params";
import type { TemplateSendability } from "../lib/template-params";
import {
  SendTestSheet,
  type SendTestPhone,
} from "../components/templates/send-test-sheet";

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
  /** Read by `analyzeTemplate` to decide whether the console can send this row. */
  category?: string;
  parameter_format?: string;
  components?: unknown;
}

/** The one template the sheet is open for. */
interface SendTarget {
  templateName: string;
  languageCode: string;
  status: string | undefined;
  sendability: TemplateSendability;
}

const columnHelper = createColumnHelper<DataGridFeatures, TemplateItem>();

const baseColumns = [
  columnHelper.accessor("name", {
    id: "name",
    header: "Name",
    cell: (info) => (
      <span className="font-mono text-xs">{info.getValue() ?? "—"}</span>
    ),
    meta: { cellClassName: "whitespace-nowrap" },
  }),
  columnHelper.accessor("language", {
    id: "language",
    header: "Language",
    cell: (info) => info.getValue() ?? "—",
    meta: { cellClassName: "whitespace-nowrap" },
  }),
  columnHelper.accessor("status", {
    id: "status",
    header: "Status",
    cell: (info) => {
      const status = info.getValue();
      return status ? <StatusTag status={status} /> : "—";
    },
    meta: { cellClassName: "whitespace-nowrap" },
  }),
];

function TemplatesPage() {
  const result = Route.useLoaderData();
  const { wabaId } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const [target, setTarget] = useState<SendTarget | null>(null);

  // Sending needs a number to send FROM, so the column only exists once the
  // account has one. In the awaiting-a-phone state the WABA is connected and
  // its templates list fine — there is simply nothing to send with, and a
  // column of disabled buttons would say that worse than no column does.
  const ready = root.ok && root.data.stage === "ready" ? root.data.scope : null;
  const selectedWabaId = wabaId ?? ready?.selectedWabaId;
  const phones: SendTestPhone[] =
    ready?.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const canSend = Boolean(selectedWabaId) && phones.length > 0;

  if (!result.ok) {
    return (
      <Page title="Templates" kicker="Cloud API">
        <FailureView failure={result} />
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

  const actionColumn = columnHelper.display({
    id: "action",
    header: "Action",
    cell: (info) => {
      const row = info.row.original;
      // Only an approved template can be sent; a pending or rejected one holds
      // the column's rhythm with a muted em-dash instead of a dead button.
      if (!canSendTemplate(row.status) || !row.name || !row.language) {
        return <span className="text-muted-foreground">—</span>;
      }
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-none"
          aria-label={`Send test message with ${row.name}`}
          onClick={() =>
            setTarget({
              templateName: row.name ?? "",
              languageCode: row.language ?? "",
              status: row.status,
              sendability: analyzeTemplate(row),
            })
          }
        >
          Send test
        </Button>
      );
    },
  });

  return (
    <Page title="Templates" kicker="Cloud API">
      <LogGrid
        columns={canSend ? [...baseColumns, actionColumn] : baseColumns}
        data={items}
        emptyMessage={
          <GridEmptyState
            label="NO TEMPLATES"
            description="Message templates approved for this WABA will appear here."
          />
        }
        getRowId={(row) => row.id ?? `${row.name ?? "?"}-${row.language ?? "?"}`}
      />
      {target && selectedWabaId ? (
        <SendTestSheet
          // Remounts per template, so a previous send's notice and inputs never
          // bleed into the next one.
          key={`${target.templateName}:${target.languageCode}`}
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          wabaId={selectedWabaId}
          templateName={target.templateName}
          languageCode={target.languageCode}
          status={target.status}
          sendability={target.sendability}
          phones={phones}
        />
      ) : null}
    </Page>
  );
}
