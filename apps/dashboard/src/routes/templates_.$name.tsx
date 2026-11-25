import { createFileRoute } from "@tanstack/react-router";
import { AuthoringScreen } from "../components/templates/authoring-screen";
import { TemplateEditorPending } from "../components/templates/template-editor";
import { CONFIG_STALE_MS } from "../lib/route-stale";
import { normalizeSearchLanguage, normalizeSearchWabaId } from "../lib/search";
import { listTemplates } from "../server/gateway";

/**
 * ── ONE TEMPLATE ────────────────────────────────────────────────────────────
 * Every language of one template name, one tab each (`?language=`), with
 * `?add=1` opening a new language draft. There is no single-template read at
 * the gateway, so the page finds the name among the templates the list loads.
 */

type TemplateSearch = { wabaId?: string; language?: string; add?: boolean };

export const Route = createFileRoute("/templates_/$name")({
  staleTime: CONFIG_STALE_MS,
  validateSearch: (search: Record<string, unknown>): TemplateSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    language: normalizeSearchLanguage(search.language),
    add: search.add === 1 || search.add === "1" || search.add === true ? true : undefined,
  }),
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => listTemplates({ data: { wabaId: deps.wabaId } }),
  component: TemplatePage,
  pendingComponent: () => <TemplateEditorPending title="Template" />,
});

function TemplatePage() {
  const result = Route.useLoaderData();
  const { name } = Route.useParams();
  const { wabaId, language, add } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AuthoringScreen
      key={name}
      result={result}
      title={name}
      mode="edit"
      wabaParam={wabaId}
      name={name}
      language={language}
      add={add}
      onLanguage={(code) =>
        navigate({ search: (prev) => ({ ...prev, language: code, add: undefined }), replace: true })
      }
    />
  );
}
