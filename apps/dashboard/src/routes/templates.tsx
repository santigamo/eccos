import { useEffect, useState } from "react";
import { createFileRoute, useLoaderData, useRouter } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { MoreHorizontalIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { invalidatePage } from "../lib/invalidate";
import { GridEmptyState } from "../components/grid/empty-state";
import { GridPending } from "../components/grid/grid-pending";
import { LogGrid } from "../components/grid/log-grid";
import type { DataGridFeatures } from "../components/reui/data-grid/data-grid";
import { listTemplates } from "../server/gateway";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "../components/reui/frame";
import { COUNT_LINK, Page, StatusTag } from "../ui";
import { FailureView } from "../components/dashboard/failure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { analyzeTemplate, canSendTemplate, templateRowsOf } from "../lib/template-params";
import {
  authoringReading,
  canEditStatus,
  categoryLabel,
  lastUpdated,
  qualityReading,
  rejectionReason,
  templateView,
  type TemplateRecord,
} from "../lib/template-view";
import { plainWhatsApp } from "../lib/whatsapp-format";
import { normalizeSearchGraphId, normalizeSearchQuery, normalizeSearchStatus, normalizeSearchWabaId } from "../lib/search";
import { SendTestSheet, type SendTestPhone } from "../components/templates/send-test-sheet";
import {
  CREATE_MODE,
  CreateTemplateSheet,
  editApprovedWarning,
  type TemplateSheetMode,
} from "../components/templates/create-template-sheet";
import { TemplateDetail, TemplatePreviewSheet } from "../components/templates/template-preview-sheet";
import { DeleteTemplateDialog, type DeleteTarget } from "../components/templates/delete-template-dialog";
import { CONFIG_STALE_MS } from "../lib/route-stale";

type TemplatesSearch = { wabaId?: string; template?: string; status?: string; q?: string };

export const Route = createFileRoute("/templates")({
  staleTime: CONFIG_STALE_MS,
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    template: normalizeSearchGraphId(search.template),
    status: normalizeSearchStatus(search.status),
    q: normalizeSearchQuery(search.q),
  }),
  // Only the WABA is a loader dep: the sheet and the filters read rows the
  // page already has.
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => listTemplates({ data: { wabaId: deps.wabaId } }),
  component: TemplatesPage,
  pendingComponent: () => <GridPending title="Templates" kicker="Cloud API" columns={pendingColumns} />,
});

const columnHelper = createColumnHelper<DataGridFeatures, TemplateRecord>();

/** Few short columns, so they are sized in percentages (data rule 4); the
 * action column stays unsized and takes the slack. */
const NAME_WIDTH = "w-[38%]";
const CATEGORY_WIDTH = "w-[12%]";
const LANGUAGE_WIDTH = "w-[10%]";
const STATUS_WIDTH = "w-[20%]";
const UPDATED_WIDTH = "w-[12%]";

const STATUS_FILTERS = ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"];

/** The row's own door into the template sheet: the name, plus a line of its body. */
function nameColumn(onOpen?: (row: TemplateRecord) => void) {
  return columnHelper.accessor("name", {
    id: "name",
    header: "Name",
    cell: (info) => {
      const row = info.row.original;
      const name = info.getValue();
      if (!name) return <span className="text-muted-foreground">—</span>;
      const text = templateView(row)?.body;
      const body = text ? plainWhatsApp(text).replace(/\s+/g, " ").trim() : "";
      return (
        <span className="flex min-w-0 flex-col gap-0.5">
          {onOpen ? (
            <button
              type="button"
              // The row handles the same click; letting it through would open the sheet twice.
              onClick={(event) => {
                event.stopPropagation();
                onOpen(row);
              }}
              aria-label={`Open ${name}`}
              className={`w-fit font-mono text-xs text-foreground ${COUNT_LINK} hover:text-primary`}
            >
              {name}
            </button>
          ) : (
            <span className="font-mono text-xs">{name}</span>
          )}
          {body ? <span className="truncate text-xs text-muted-foreground">{body}</span> : null}
        </span>
      );
    },
    meta: { headerClassName: NAME_WIDTH, cellClassName: `${NAME_WIDTH} max-w-0` },
  });
}

const categoryColumn = columnHelper.accessor("category", {
  id: "category",
  header: "Category",
  cell: (info) => categoryLabel(info.getValue()),
  meta: { headerClassName: CATEGORY_WIDTH, cellClassName: `${CATEGORY_WIDTH} whitespace-nowrap` },
});

const languageColumn = columnHelper.accessor("language", {
  id: "language",
  header: "Language",
  cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? "—"}</span>,
  meta: { headerClassName: LANGUAGE_WIDTH, cellClassName: `${LANGUAGE_WIDTH} whitespace-nowrap` },
});

/** The status tag, plus the one reason an operator would act on: a rejection, or poor quality. */
const statusColumn = columnHelper.accessor("status", {
  id: "status",
  header: "Status",
  cell: (info) => {
    const row = info.row.original;
    const status = info.getValue();
    const rejected = rejectionReason(row);
    const quality = qualityReading(row);
    const note = rejected
      ? { text: rejected, ink: "text-destructive-foreground" }
      : quality && quality.tone !== "neutral"
        ? {
            text: `${quality.label} quality`,
            ink: quality.tone === "warning" ? "text-[#f0a020]" : "text-destructive-foreground",
          }
        : null;
    return (
      <span className="flex flex-col items-start gap-1">
        {status ? <StatusTag status={status} /> : "—"}
        {note ? <span className={`text-xs ${note.ink}`}>{note.text}</span> : null}
      </span>
    );
  },
  meta: { headerClassName: STATUS_WIDTH, cellClassName: STATUS_WIDTH },
});

const updatedColumn = columnHelper.display({
  id: "updated",
  header: "Updated",
  cell: (info) => {
    const date = lastUpdated(info.row.original);
    return date ? (
      <span className="font-mono text-xs" title={date.toISOString()}>
        {date.toISOString().slice(0, 10)}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  },
  meta: { headerClassName: UPDATED_WIDTH, cellClassName: `${UPDATED_WIDTH} whitespace-nowrap` },
});

/** The pending view reads only the headers; the empty action column keeps its layout. */
const pendingColumns = [
  nameColumn(),
  categoryColumn,
  languageColumn,
  statusColumn,
  updatedColumn,
  columnHelper.display({
    id: "action",
    header: () => <span className="sr-only">Actions</span>,
    cell: () => null,
    meta: { skeleton: null },
  }),
];

/** Rows matching the status filter and the search box (name or body text). */
export function filterTemplates(rows: TemplateRecord[], status?: string, query?: string): TemplateRecord[] {
  const needle = query?.toLowerCase();
  return rows.filter((row) => {
    if (status && row.status?.toUpperCase() !== status.toUpperCase()) return false;
    if (!needle) return true;
    const body = templateView(row)?.body.toLowerCase() ?? "";
    return (row.name ?? "").toLowerCase().includes(needle) || body.includes(needle);
  });
}

function TemplatesPage() {
  const result = Route.useLoaderData();
  const { wabaId, template, status, q } = Route.useSearch();
  const navigate = Route.useNavigate();
  const root = useLoaderData({ from: "__root__" });
  const router = useRouter();
  const [sending, setSending] = useState<TemplateRecord | null>(null);
  const [authoring, setAuthoring] = useState<TemplateSheetMode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  // The box follows the URL (Clear filters, Back) without fighting a trailing space being typed.
  const [searchText, setSearchText] = useState(q ?? "");
  useEffect(() => {
    setSearchText((text) => (normalizeSearchQuery(text) === q ? text : (q ?? "")));
  }, [q]);

  const ready = root.ok && root.data.stage === "ready" ? root.data.scope : null;
  const selectedWabaId = wabaId ?? ready?.selectedWabaId;
  const phones: SendTestPhone[] =
    ready?.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  const canSend = Boolean(selectedWabaId) && phones.length > 0;
  const businessName = phones[0]?.displayPhoneNumber || "Your business";

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
      typeof templates.error === "string" ? templates.error : JSON.stringify(templates.error, null, 2);
    return (
      <Page title="Templates" kicker="Cloud API">
        <Frame variant="default" spacing="sm">
          <FramePanel fit>
            <FrameHeader>
              <FrameTitle>Failed to load templates</FrameTitle>
              <FrameDescription>The gateway returned an error while loading message templates.</FrameDescription>
            </FrameHeader>
            <pre className="mt-2 overflow-auto border border-destructive/20 bg-destructive/10 p-3 text-destructive-foreground text-xs whitespace-pre-wrap break-words">
              {detail}
            </pre>
          </FramePanel>
        </Frame>
      </Page>
    );
  }

  const rows = templateRowsOf(templates.data) as TemplateRecord[];
  const visible = filterTemplates(rows, status, q);
  const opened = template ? rows.find((row) => row.id === template) : undefined;

  const openTemplate = (row: TemplateRecord) => {
    if (row.id) navigate({ search: (prev) => ({ ...prev, template: row.id }) });
  };
  const closeTemplate = () => navigate({ search: (prev) => ({ ...prev, template: undefined }), replace: true });

  /** What each row allows, decided once for the menu and the sheet alike. */
  function actionsFor(row: TemplateRecord) {
    const authoring = authoringReading(row);
    const sendable = canSend && canSendTemplate(row.status) && Boolean(row.name && row.language);
    const editable = authoring.ok && Boolean(row.id) && canEditStatus(row.status);
    return {
      onSend: sendable ? () => setSending(row) : undefined,
      onEdit:
        editable && authoring.ok && row.id
          ? () => {
              setAuthoring({ kind: "edit", initial: authoring.draft, templateId: row.id ?? "", status: row.status });
              const warning = editApprovedWarning(row.status);
              if (warning) toast.warning(warning, { id: "edit-approved", duration: 10_000 });
            }
          : undefined,
      onDuplicate: authoring.ok ? () => setAuthoring({ kind: "duplicate", initial: authoring.draft }) : undefined,
      onDelete:
        row.id && row.name && row.language && row.status?.toUpperCase() !== "PENDING_DELETION"
          ? () =>
              setDeleteTarget({
                templateId: row.id ?? "",
                name: row.name ?? "",
                language: row.language ?? "",
                status: row.status,
              })
          : undefined,
      authoringBlocked: authoring.ok ? null : authoring.reason,
    };
  }

  const actionColumn = columnHelper.display({
    id: "action",
    header: () => <span className="sr-only">Actions</span>,
    cell: (info) => {
      const row = info.row.original;
      const actions = actionsFor(row);
      if (!actions.onSend && !actions.onEdit && !actions.onDuplicate && !actions.onDelete) {
        return <span className="text-muted-foreground">—</span>;
      }
      return <TemplateRowActions name={row.name ?? ""} language={row.language} {...actions} />;
    },
    meta: { headerClassName: "text-right", cellClassName: "text-right whitespace-nowrap" },
  });

  const setFilter = (patch: Partial<TemplatesSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  const toolbar = (
    <>
      <label className="sr-only" htmlFor="template-search">
        Search templates by name or text
      </label>
      <span className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id="template-search"
          type="search"
          value={searchText}
          placeholder="Search"
          autoComplete="off"
          className="h-8 w-44 rounded-none pl-7 text-sm"
          onChange={(event) => {
            setSearchText(event.target.value);
            setFilter({ q: normalizeSearchQuery(event.target.value) });
          }}
        />
      </span>
      <label className="sr-only" htmlFor="template-status-filter">
        Filter templates by status
      </label>
      <Select value={status ?? "all"} onValueChange={(value) => setFilter({ status: !value || value === "all" ? undefined : value })}>
        <SelectTrigger id="template-status-filter" size="sm" className="w-36">
          <SelectValue>{(value: string | null) => (value === "all" ? "all statuses" : value?.toLowerCase())}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="all">all statuses</SelectItem>
          {STATUS_FILTERS.map((value) => (
            <SelectItem key={value} value={value}>
              {value.toLowerCase()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedWabaId ? (
        <Button type="button" size="sm" onClick={() => setAuthoring(CREATE_MODE)}>
          New template
        </Button>
      ) : null}
    </>
  );

  const narrowed = Boolean(status || q);

  return (
    <Page title="Templates" kicker="Cloud API" actions={toolbar}>
      <LogGrid
        columns={
          selectedWabaId
            ? [nameColumn(openTemplate), categoryColumn, languageColumn, statusColumn, updatedColumn, actionColumn]
            : [nameColumn(openTemplate), categoryColumn, languageColumn, statusColumn, updatedColumn]
        }
        data={visible}
        onRowClick={openTemplate}
        emptyMessage={
          narrowed ? (
            <GridEmptyState
              label="NO MATCHES"
              description="No templates match this search."
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-none"
                  onClick={() => setFilter({ status: undefined, q: undefined })}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <GridEmptyState
              label="NO TEMPLATES"
              description="Message templates on this WhatsApp Business Account will appear here."
            />
          )
        }
        getRowId={(row) => row.id ?? `${row.name ?? "?"}-${row.language ?? "?"}`}
      />

      {template && selectedWabaId ? (
        <TemplatePreviewSheet
          key={`template:${template}`}
          open
          onOpenChange={(open) => {
            if (!open) closeTemplate();
          }}
          title={opened ? `${opened.name ?? "—"} · ${opened.language ?? "—"}` : "Template"}
        >
          {opened ? (
            <TemplateDetail
              row={opened}
              wabaId={selectedWabaId}
              businessName={businessName}
              actions={handOff(actionsFor(opened), closeTemplate)}
            />
          ) : (
            <div className="px-4 pb-4">
              <GridEmptyState
                label="NOT FOUND"
                description="No template with this id is on this WhatsApp Business Account. It may have been deleted."
              />
            </div>
          )}
        </TemplatePreviewSheet>
      ) : null}

      {sending && selectedWabaId ? (
        <SendTestSheet
          key={`${sending.name}:${sending.language}`}
          open
          onOpenChange={(open) => {
            if (!open) setSending(null);
          }}
          wabaId={selectedWabaId}
          templateName={sending.name ?? ""}
          languageCode={sending.language ?? ""}
          status={sending.status}
          sendability={analyzeTemplate(sending)}
          phones={phones}
          view={templateView(sending)}
        />
      ) : null}

      {authoring && selectedWabaId ? (
        <CreateTemplateSheet
          key={authoring.kind === "edit" ? `edit:${authoring.templateId}` : authoring.kind}
          open
          onOpenChange={(open) => {
            if (!open) setAuthoring(null);
          }}
          wabaId={selectedWabaId}
          mode={authoring}
          businessName={businessName}
          onCreated={() => invalidatePage(router)}
        />
      ) : null}

      {deleteTarget && selectedWabaId ? (
        <DeleteTemplateDialog
          key={deleteTarget.templateId}
          wabaId={selectedWabaId}
          target={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onDeleted={() => {
            if (template === deleteTarget.templateId) closeTemplate();
            invalidatePage(router);
          }}
        />
      ) : null}
    </Page>
  );
}

/** An act started from the template sheet closes it first: one sheet at a time. */
function handOff<T extends Record<string, unknown>>(actions: T, close: () => void): T {
  return Object.fromEntries(
    Object.entries(actions).map(([key, value]) => [
      key,
      typeof value === "function"
        ? () => {
            close();
            value();
          }
        : value,
    ]),
  ) as T;
}

/**
 * The row's acts behind one kebab: they all leave the console or open a form,
 * so a deliberate second click is right (data rule 5). Reading the template is
 * the row itself.
 */
function TemplateRowActions({
  name,
  language,
  onSend,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  name: string;
  language: string | undefined;
  onSend?: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  return (
    // Stops the row's click, and covers only the trigger (inline-flex): see
    // DASHBOARD-DESIGN.md, "Table rows".
    // biome-ignore lint/a11y/useKeyWithClickEvents: a shield over the trigger, not a control
    <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-none"
              aria-label={`Actions for ${name}${language ? ` (${language})` : ""}`}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {onSend ? <DropdownMenuItem onClick={onSend}>Send test</DropdownMenuItem> : null}
          {onEdit ? <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem> : null}
          {onDuplicate ? <DropdownMenuItem onClick={onDuplicate}>Duplicate</DropdownMenuItem> : null}
          {onDelete ? (
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
