import { useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
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
import { CreateTemplateSheet } from "../components/templates/create-template-sheet";
import { TemplatePreviewSheet } from "../components/templates/template-preview-sheet";
import {
  DeleteTemplateDialog,
  type DeleteTarget,
} from "../components/templates/delete-template-dialog";

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

/** The template row the preview sheet is open for. */
interface PreviewTarget {
  templateName: string;
  language: string | undefined;
  components?: unknown;
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
  const router = useRouter();
  const [target, setTarget] = useState<SendTarget | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

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
      // Only an approved template can be sent, and sending needs a number to
      // send FROM. Deleting needs neither — but it does need the Graph id that
      // identifies this exact name+language pair, and Meta gives a row already
      // queued for deletion nothing left to delete. Previewing needs nothing
      // beyond the row itself: `listTemplates` requests no `fields`, so the
      // default Meta response already carries `components` and the sheet
      // renders that array (docs/console-gaps-2026-09 §4).
      const sendable = canSend && canSendTemplate(row.status) && Boolean(row.name && row.language);
      const deletable =
        Boolean(row.id && row.name && row.language) &&
        row.status?.toUpperCase() !== "PENDING_DELETION";
      // Preview is read-only and always says something honest: every row can
      // be previewed, including one whose `components` came back empty (the
      // sheet answers with a graceful empty state, not a crash).
      const previewable = Boolean(row.name);
      // Data rule 5: a row with no action holds the column's rhythm with a
      // muted em-dash rather than a dead button.
      if (!previewable && !sendable && !deletable) {
        return <span className="text-muted-foreground">—</span>;
      }
      return (
        <span className="flex items-center gap-2">
          {previewable ? (
            // Ghost anatomy, quiet: previewing reads the row and never mutates,
            // so it rests lighter than "Send test" beside it — the page's one
            // primary and the destructive ink stay elsewhere.
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-none"
              aria-label={`Preview ${row.name}`}
              onClick={() =>
                setPreviewTarget({
                  templateName: row.name ?? "",
                  language: row.language,
                  components: row.components,
                })
              }
            >
              Preview
            </Button>
          ) : null}
          {sendable ? (
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
          ) : null}
          {deletable ? (
            // Deleting removes a template, so the trigger must not read at the
            // same weight as "Send test" beside it — destructive ink, ghost
            // anatomy (docs/console-gaps-2026-09 §3). The ink is the semantic
            // --color-destructive-foreground token, never a literal hex, and
            // the fill stays ghost: this page's one primary is elsewhere.
            // Hover keeps the ink because the ghost variant's own hover
            // rule would otherwise white it back out.
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-none text-destructive-foreground hover:text-destructive-foreground"
              aria-label={`Delete ${row.name} (${row.language})`}
              onClick={() =>
                setDeleteTarget({
                  templateId: row.id ?? "",
                  name: row.name ?? "",
                  language: row.language ?? "",
                  status: row.status,
                })
              }
            >
              Delete
            </Button>
          ) : null}
        </span>
      );
    },
  });

  // Creation is a WABA-level act, so it is offered as soon as a WABA is
  // selected — deliberately NOT gated on `canSend`. An account whose number is
  // still provisioning is exactly the one preparing its templates. The role
  // check is the server's: a refusal comes back typed and renders as copy in
  // the sheet's notice (data rule 7), rather than as a hidden button.
  const createAction = selectedWabaId ? (
    <Button type="button" size="sm" onClick={() => setCreating(true)}>
      New template
    </Button>
  ) : null;

  return (
    <Page title="Templates" kicker="Cloud API" actions={createAction}>
      <LogGrid
        // The column exists as soon as a WABA does: deleting works without a
        // phone number, and the awaiting-a-phone account is exactly the one
        // cleaning up its first drafts.
        columns={selectedWabaId ? [...baseColumns, actionColumn] : baseColumns}
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
      {previewTarget ? (
        <TemplatePreviewSheet
          // Remounted per row, so one row's components never render over
          // another's.
          key={`preview:${previewTarget.templateName}:${previewTarget.language ?? ""}`}
          open
          onOpenChange={(open) => {
            if (!open) setPreviewTarget(null);
          }}
          templateName={previewTarget.templateName}
          language={previewTarget.language}
          components={previewTarget.components}
        />
      ) : null}
      {creating && selectedWabaId ? (
        <CreateTemplateSheet
          // Remounted per opening, so a submitted draft never bleeds into the
          // next one.
          open
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          wabaId={selectedWabaId}
          onCreated={() => router.invalidate()}
        />
      ) : null}
      {deleteTarget && selectedWabaId ? (
        <DeleteTemplateDialog
          // Remounted per row, so one row's refusal never shows over another.
          key={deleteTarget.templateId}
          wabaId={selectedWabaId}
          target={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onDeleted={() => router.invalidate()}
        />
      ) : null}
    </Page>
  );
}
