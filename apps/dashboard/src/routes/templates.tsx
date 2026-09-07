import { useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { MoreHorizontalIcon } from "lucide-react";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
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
import { COUNT_LINK, Page, StatusTag } from "../ui";
import { FailureView } from "../components/dashboard/failure";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  // Past `defaultPendingMs` the previous page's rows are replaced by this
  // page's structure, instead of lingering under the new sidebar highlight.
  pendingComponent: () => (
    <GridPending title="Templates" kicker="Cloud API" columns={pendingColumns} />
  ),
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

/**
 * The name cell — and, when the page can open one, the row's visible door into
 * the preview.
 *
 * PREVIEW IS A ROW CLICK NOW, and this is what keeps that honest. The grid
 * hangs `onRowClick` off a bare `<tr>`: no role, no tab stop, nothing a
 * keyboard or a screen reader can reach, and nothing on screen that says the
 * row is a door. A preview reachable only by clicking somewhere unmarked is
 * exactly the affordance-on-hover the design contract rules out.
 *
 * So the name carries the console's existing door anatomy — the one `ui.tsx`
 * gives a count that navigates: quiet at rest, underlined and green under the
 * pointer, focusable, with the ring. The row click is then a convenience over
 * a control that already exists, not the only way in.
 *
 * `onPreview` is optional because the same column also draws the pending
 * view's header, where there is no row to open.
 */
function nameColumn(onPreview?: (row: TemplateItem) => void) {
  return columnHelper.accessor("name", {
    id: "name",
    header: "Name",
    cell: (info) => {
      const name = info.getValue();
      if (!name) return <span className="text-muted-foreground">—</span>;
      if (!onPreview) return <span className="font-mono text-xs">{name}</span>;
      return (
        <button
          type="button"
          // Stops here: the same click is already handled by the row, and
          // letting it through would open the sheet twice.
          onClick={(event) => {
            event.stopPropagation();
            onPreview(info.row.original);
          }}
          aria-label={`Preview ${name}`}
          className={`font-mono text-xs text-foreground ${COUNT_LINK} hover:text-primary`}
        >
          {name}
        </button>
      );
    },
    meta: { cellClassName: "whitespace-nowrap" },
  });
}

const languageColumn = columnHelper.accessor("language", {
  id: "language",
  header: "Language",
  cell: (info) => info.getValue() ?? "—",
  meta: { cellClassName: "whitespace-nowrap" },
});

const statusColumn = columnHelper.accessor("status", {
  id: "status",
  header: "Status",
  cell: (info) => {
    const status = info.getValue();
    return status ? <StatusTag status={status} /> : "—";
  },
  meta: { cellClassName: "whitespace-nowrap" },
});

/**
 * What the pending view draws. Only the HEADERS are read there — the grid
 * paints `meta.skeleton` in every cell while it loads — so the inert name
 * column is exactly right, and there is no second list to keep in step.
 *
 * The action column is present but empty, and it has to be: it is the one that
 * takes the table's slack (see its `meta` below), so leaving it out would let
 * the three real columns stretch across the full width and then snap back the
 * moment the rows arrive. A skeleton that predicts a different layout from the
 * one replacing it is worse than none.
 */
const pendingColumns = [
  nameColumn(),
  languageColumn,
  statusColumn,
  columnHelper.display({
    id: "action",
    header: () => <span className="sr-only">Actions</span>,
    cell: () => null,
    meta: { headerClassName: "w-full", cellClassName: "w-full", skeleton: null },
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

  /** Opening the preview: the name cell, the row itself, and nothing else. */
  const openPreview = (row: TemplateItem) => {
    if (!row.name) return;
    setPreviewTarget({
      templateName: row.name,
      language: row.language,
      components: row.components,
    });
  };

  const actionColumn = columnHelper.display({
    id: "action",
    // No visible header. The cell holds one kebab, and a word over it would
    // name the column rather than the act — every other header on this grid
    // names what is IN the column. The label stays for assistive tech.
    header: () => <span className="sr-only">Actions</span>,
    cell: (info) => {
      const row = info.row.original;
      // Only an approved template can be sent, and sending needs a number to
      // send FROM. Deleting needs neither — but it does need the Graph id that
      // identifies this exact name+language pair, and Meta gives a row already
      // queued for deletion nothing left to delete.
      //
      // PREVIEW IS NO LONGER HERE: it moved onto the row and onto the name
      // cell above, because it is the one act that only reads. What is left in
      // this column both WRITES — one sends a real WhatsApp message, the other
      // deletes a template — which is what makes a menu the right container:
      // it costs a deliberate second click, and it stops the row's identity
      // from competing with three buttons.
      const sendable = canSend && canSendTemplate(row.status) && Boolean(row.name && row.language);
      const deletable =
        Boolean(row.id && row.name && row.language) &&
        row.status?.toUpperCase() !== "PENDING_DELETION";
      // Data rule 5: a row with no action holds the column's rhythm with a
      // muted em-dash rather than an empty menu.
      if (!sendable && !deletable) {
        return <span className="text-muted-foreground">—</span>;
      }
      return (
        <TemplateRowActions
          name={row.name ?? ""}
          language={row.language}
          onSend={
            sendable
              ? () =>
                  setTarget({
                    templateName: row.name ?? "",
                    languageCode: row.language ?? "",
                    status: row.status,
                    sendability: analyzeTemplate(row),
                  })
              : undefined
          }
          onDelete={
            deletable
              ? () =>
                  setDeleteTarget({
                    templateId: row.id ?? "",
                    name: row.name ?? "",
                    language: row.language ?? "",
                    status: row.status,
                  })
              : undefined
          }
        />
      );
    },
    // Right-aligned, and the header goes with it (data rule 4). The column
    // takes the table's SLACK rather than hugging the kebab: with only three
    // short columns beside it, a `w-px` action cell hands every spare pixel to
    // the first column instead, and the name floats half a screen away from
    // its own language and status.
    meta: {
      headerClassName: "w-full text-right",
      cellClassName: "w-full text-right whitespace-nowrap",
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
        // The action column exists as soon as a WABA does: deleting works
        // without a phone number, and the awaiting-a-phone account is exactly
        // the one cleaning up its first drafts.
        columns={
          selectedWabaId
            ? [nameColumn(openPreview), languageColumn, statusColumn, actionColumn]
            : [nameColumn(openPreview), languageColumn, statusColumn]
        }
        data={items}
        // The row is the WIDE door into the preview; the name cell is the one
        // that can be tabbed to and the one that says so. Both land on the
        // same read-only sheet, and the kebab beside them stops its own click
        // so opening the menu never opens the sheet behind it.
        onRowClick={openPreview}
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

/**
 * The row's two writing acts, behind one kebab.
 *
 * WHY A MENU AND NOT TWO BUTTONS. Both of these change something outside the
 * console — one sends a real WhatsApp message to a real number, the other
 * deletes a template at Meta — and they used to sit inline, two clicks wide,
 * on every row of a table whose subject is the template NAME. Collapsing them
 * costs a deliberate second click on exactly the two acts that deserve one,
 * and gives the name back the width it was competing for.
 *
 * The trigger is ghost and the Delete item carries the destructive ink the
 * contract fixes for dark surfaces (`--destructive-foreground`, #ff7777 — the
 * `#e03131` surface colour is ~3.9:1 as text and is never used as text). One
 * primary per view still holds: it is "New template", above the grid.
 */
function TemplateRowActions({
  name,
  language,
  onSend,
  onDelete,
}: {
  name: string;
  language: string | undefined;
  onSend?: () => void;
  onDelete?: () => void;
}) {
  return (
    // The kebab lives inside a `<tr onClick>` that opens the preview, so this
    // click has to stop here — otherwise reaching for the menu would also open
    // the sheet behind it. The menu's own items are portalled and never bubble
    // through the row at all.
    //
    // `inline-flex`, and it matters: this column takes the table's slack, so a
    // `flex justify-end` shield stretches across the whole width of it and
    // swallows every row click that lands right of Status. That shipped, and
    // the row read as dead over half the table while the name cell — well
    // outside the shield — kept working. The cell's `text-right` is what puts
    // this at the right edge; the span itself covers only the trigger.
    // biome-ignore lint/a11y/useKeyWithClickEvents: not a control — a shield over one. It takes no role and no tab stop; the keyboard reaches the trigger inside it directly, and a key handler here would fire on the trigger's own Enter.
    <span
      className="inline-flex"
      onClick={(event) => event.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              // Open state is already the ghost variant's `aria-expanded`
              // rule, which Base UI sets on the trigger.
              className="rounded-none"
              aria-label={`Actions for ${name}${language ? ` (${language})` : ""}`}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {onSend ? (
            <DropdownMenuItem onClick={onSend}>Send test</DropdownMenuItem>
          ) : null}
          {onDelete ? (
            // The destructive ink lives in the component, not here: a
            // variant-prefixed utility beats an unprefixed className, so an
            // override at this call site loses silently.
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
