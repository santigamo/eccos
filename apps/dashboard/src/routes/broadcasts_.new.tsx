import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { TEMPLATE_NAME_PATTERN, templateRowsOf } from "@eccos/core/template-rules";
import { Callout } from "@/components/ui/callout";
import { NewBroadcast } from "../components/broadcasts/new-broadcast";
import { FailureView } from "../components/dashboard/failure";
import { TemplateEditorPending } from "../components/templates/template-editor";
import { loaderFailure } from "../lib/failure";
import { countryOf } from "../lib/phone-number";
import { CONFIG_STALE_MS } from "../lib/route-stale";
import { normalizeSearchLanguage, normalizeSearchWabaId } from "../lib/search";
import { broadcastBlock } from "../lib/sends-paused";
import type { TemplateRecord } from "../lib/template-view";
import { getBroadcastPreflight, listTemplates } from "../server/gateway";
import { Page } from "../ui";

type NewBroadcastSearch = { wabaId?: string; template?: string; language?: string; step?: "review" };

export const Route = createFileRoute("/broadcasts_/new")({
  staleTime: CONFIG_STALE_MS,
  validateSearch: (search: Record<string, unknown>): NewBroadcastSearch => ({
    wabaId: normalizeSearchWabaId(search.wabaId),
    template: typeof search.template === "string" && TEMPLATE_NAME_PATTERN.test(search.template) ? search.template : undefined,
    language: normalizeSearchLanguage(search.language),
    step: search.step === "review" ? "review" : undefined,
  }),
  // The step is page state, never a reload: only the WABA reads anything.
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: async ({ deps }) => {
    const [templates, preflight] = await Promise.all([
      listTemplates({ data: { wabaId: deps.wabaId } }).catch(loaderFailure),
      getBroadcastPreflight({ data: { wabaId: deps.wabaId } }).catch(loaderFailure),
    ]);
    return { templates, preflight };
  },
  component: NewBroadcastPage,
  pendingComponent: () => <TemplateEditorPending title="New broadcast" kicker="Sending" />,
});

function NewBroadcastPage() {
  const { templates, preflight } = Route.useLoaderData();
  const { wabaId, template, language, step } = Route.useSearch();
  const navigate = Route.useNavigate();
  const root = useLoaderData({ from: "__root__" });

  const failure = !preflight.ok ? preflight : !templates.ok ? templates : null;
  if (failure) {
    return (
      <Page title="New broadcast" kicker="Sending">
        <FailureView failure={failure} />
      </Page>
    );
  }
  if (!templates.ok || !preflight.ok) return null;

  const scope = root.ok && root.data.stage === "ready" ? root.data.scope : null;
  const selectedWabaId = wabaId ?? scope?.selectedWabaId ?? "";
  const phones = scope?.resources.wabas.find((waba) => waba.wabaId === selectedWabaId)?.phones ?? [];
  if (!templates.data.ok) {
    return (
      <Page title="New broadcast" kicker="Sending">
        <Callout tone="error">Eccos could not read your templates from Meta. Reload the page to try again.</Callout>
      </Page>
    );
  }
  const rows = templateRowsOf(templates.data.data) as TemplateRecord[];

  return (
    <NewBroadcast
      wabaId={selectedWabaId}
      wabaParam={wabaId}
      templates={rows}
      preflight={preflight.data}
      phones={phones}
      country={countryOf(phones[0]?.displayPhoneNumber)}
      blocked={broadcastBlock(root)}
      initialTemplate={template && language ? `${template}:${language}` : undefined}
      reviewing={step === "review"}
      onStep={(review) => navigate({ search: (prev) => ({ ...prev, step: review ? "review" : undefined }) })}
    />
  );
}
