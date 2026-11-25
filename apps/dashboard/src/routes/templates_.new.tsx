import { createFileRoute } from "@tanstack/react-router";
import { AuthoringScreen } from "../components/templates/authoring-screen";
import { TemplateEditorPending } from "../components/templates/template-editor";
import { CONFIG_STALE_MS } from "../lib/route-stale";
import { normalizeSearchLanguage, normalizeSearchTemplateName, normalizeSearchWabaId } from "../lib/search";
import { listTemplates } from "../server/gateway";

/**
 * ── NEW TEMPLATE ────────────────────────────────────────────────────────────
 * Authoring as a page, not a sheet: a template is a document with one version
 * per language, it needs an address (`?from=` duplicates, `?language=` picks
 * the tab), and it needs the room. The list is read for the account's usual
 * language and for a duplicate's source.
 */

type NewTemplateSearch = { wabaId?: string; from?: string; language?: string };

export const Route = createFileRoute("/templates_/new")({
  staleTime: CONFIG_STALE_MS,
  validateSearch: (search: Record<string, unknown>): NewTemplateSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    from: normalizeSearchTemplateName(search.from),
    language: normalizeSearchLanguage(search.language),
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => listTemplates({ data: { wabaId: deps.wabaId } }),
  component: NewTemplatePage,
  pendingComponent: () => <TemplateEditorPending title="New template" />,
});

function NewTemplatePage() {
  const result = Route.useLoaderData();
  const { wabaId, from, language } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AuthoringScreen
      key={from ?? "new"}
      result={result}
      title="New template"
      mode="create"
      wabaParam={wabaId}
      from={from}
      language={language}
      onLanguage={(code) => navigate({ search: (prev) => ({ ...prev, language: code }), replace: true })}
    />
  );
}
