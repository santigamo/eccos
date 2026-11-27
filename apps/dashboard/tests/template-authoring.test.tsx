import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The template authoring page (`/templates/new`, `/templates/$name`): the tab
 * model and its state words (`lib/template-group.ts`), the requests and the
 * serial send (`lib/template-submit.ts`), and the page rendered with the router
 * hooks stubbed, the same approach as `templates-screen.test.tsx`.
 */

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

/** What the page handed `useBlocker` on its last render. */
let blockerOpts: { shouldBlockFn: (args: unknown) => boolean; enableBeforeUnload: boolean } | null = null;

const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  useBlocker: (opts: typeof blockerOpts) => {
    blockerOpts = opts;
    return { status: "idle" };
  },
  useNavigate: () => () => {},
  useRouter: () => ({ invalidate: async () => {} }),
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}));

const G = await import("../src/lib/template-group");
const { afterCreate, movedCategory, refusal, requestFor, submitSerially, UNANSWERED } = await import(
  "../src/lib/template-submit"
);
const { createTemplateFailureCopy, editTemplateFailureCopy } = await import("../src/lib/failure");
const { TemplateEditor, leaveBlocker } = await import("../src/components/templates/template-editor");
const { dropHandoff, putHandoff } = await import("../src/lib/template-handoff");

const draft = (language: string, body = "") => ({ language, body, examples: [], footer: "", buttons: [] });
const ready = (language: string) => draft(language, "Your order is on its way and arrives tomorrow.");
const row = (language: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${language}`,
  name: "order_update",
  language,
  status,
  category: "UTILITY",
  components: [{ type: "BODY", text: "Your order is on its way." }],
  ...extra,
});
const refused = { title: "Meta refused the template", detail: "d" };

type Input = Parameters<typeof G.buildTabs>[0];
function tabs(input: Partial<Input> & { rows: Input["rows"] }) {
  return G.buildTabs({ languages: {}, category: "UTILITY", initialCategory: "UTILITY", ...input });
}

describe("a language the form cannot hold", () => {
  test("reads as the form would show it, from what Meta stores", () => {
    const [tab] = tabs({
      rows: [
        row("es", "APPROVED", {
          parameter_format: "NAMED",
          components: [
            {
              type: "BODY",
              text: "Hola, {{customer_name}}.",
              example: { body_text_named_params: [{ param_name: "customer_name", example: "María" }] },
            },
            { type: "FOOTER", text: "Equipo" },
            { type: "BUTTONS", buttons: [{ type: "PHONE_NUMBER", text: "Llamar", phone_number: "+34600000000" }] },
          ],
        }),
      ],
    });
    if (!tab) throw new Error("no tab");
    expect(tab.readOnly).toContain("named variables");
    expect(tab.dirty).toBe(false);
    expect(G.readOnlyContent(tab)).toEqual({
      header: null,
      body: "Hola, {{customer_name}}.",
      examples: [["{{customer_name}}", "María"]],
      footer: "Equipo",
      buttons: [{ text: "Llamar", target: "+34600000000", example: "" }],
    });
  });
});

describe("the tab's state word", () => {
  test("one word per situation, never a dot", () => {
    const all = tabs({
      rows: [row("en_US", "APPROVED"), row("es", "APPROVED"), row("it", "PENDING"), row("fr", "REJECTED"), row("ca", "APPROVED")],
      languages: {
        es: { draft: draft("es", "Tu pedido va en camino y llega mañana.") },
        ca: { draft: draft("ca", "Una altra cosa del tot diferent."), error: refused },
        de: { added: true },
        nl: { added: true, draft: ready("nl"), error: refused },
      },
    });
    expect(all.map((tab) => [tab.language, G.tabState(tab)])).toEqual([
      ["en_US", null],
      ["es", "EDITED"],
      ["it", "IN REVIEW"],
      ["fr", "REJECTED"],
      ["ca", "EDIT REFUSED"],
      ["de", "INCOMPLETE"],
      ["nl", "NOT CREATED"],
    ]);
  });

  test("an edited language that no longer passes the rules is INCOMPLETE", () => {
    const [tab] = tabs({ rows: [row("en_US", "APPROVED")], languages: { en_US: { draft: draft("en_US", "") } } });
    expect(G.tabState(tab!)).toBe("INCOMPLETE");
  });

  test("the state is in the tab's accessible name", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED"), row("it", "PENDING")], language: "en_US" });
    expect(html).toContain('aria-label="Italiano, it, in review"');
    expect(html).toContain('aria-label="English (US), en_US"');
    expect(html).toContain(">IN REVIEW<");
  });
});

describe("a send in flight", () => {
  test("its outcome is patched onto the latest languages, so nothing touched meanwhile is lost", () => {
    const latest = {
      es: { added: true, draft: ready("es") },
      it: { added: true, draft: draft("it", "Typed while the send was running.") },
    };
    const after = G.applySend(latest, [ready("es")], { language: "fr", notice: refused });
    expect(after.es).toEqual({ added: true, draft: ready("es"), sent: ready("es"), error: undefined });
    expect(after.it).toEqual(latest.it);
    expect(after.fr).toEqual({ error: refused });
  });

  test("the fields are disabled while it runs", async () => {
    const source = await Bun.file(new URL("../src/components/templates/template-editor.tsx", import.meta.url)).text();
    expect(source).toContain("<fieldset disabled={submitting}");
  });

  test("a send that threw but reached Meta reads as in review once Meta lists it", () => {
    const [tab] = tabs({ rows: [row("es", "PENDING")], languages: { es: { added: true, draft: ready("es"), error: UNANSWERED } } });
    expect(G.tabState(tab!)).toBe("IN REVIEW");
  });
});

describe("a refused edit is not a refused creation", () => {
  test("its own word, its own sentence, and Meta's real status in the review list", () => {
    const [tab] = tabs({ rows: [row("en_US", "APPROVED")], languages: { en_US: { draft: ready("en_US"), error: refused } } });
    expect(G.tabState(tab!)).toBe("EDIT REFUSED");
    expect(G.refusalLine(tab!)).toBe("Meta refused the changes to English (US).");
    expect(G.barNote("edit", G.submission([tab!]), [])).toBe("Meta refused the changes to English (US).");
    expect(G.primaryLabel("edit", G.submission([tab!]), "en_US")).toBe("Retry English (US)");
    const [draftTab] = tabs({ rows: [], languages: { es: { added: true, draft: ready("es"), error: refused } } });
    expect(G.refusalLine(draftTab!)).toBe("Meta did not create Español.");
  });
});

describe("a language in review", () => {
  test("is read-only, and the page shows no submit bar for it", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED"), row("it", "PENDING")], language: "it" });
    expect(html).toContain("Meta is reviewing Italiano, usually for a few minutes.");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(">Cancel<");
  });

  test("a language this page sent reads as in review until the page is left", () => {
    const [tab] = tabs({ rows: [row("en_US", "APPROVED")], languages: { en_US: { sent: ready("en_US") } } });
    expect(tab?.status).toBe("PENDING");
    expect(tab?.readOnly).toContain("Meta is reviewing");
  });
});

describe("the category", () => {
  test("the group's is the most common one the console authors", () => {
    expect(G.groupCategory([row("en_US", "APPROVED"), row("es", "APPROVED", { category: "MARKETING" })])).toBe("UTILITY");
    expect(
      G.groupCategory([row("en_US", "APPROVED", { category: "MARKETING" }), row("es", "APPROVED", { category: "MARKETING" }), row("it", "APPROVED")]),
    ).toBe("MARKETING");
  });

  test("it is locked only when no language at Meta can take a new one", () => {
    expect(G.categoryLock([row("en_US", "APPROVED")])).toBe("Locked while a language is approved");
    expect(G.categoryLock([row("en_US", "PENDING")])).toBe("Locked while Meta reviews a language");
    // A rejected language stays fixable beside an approved sibling.
    expect(G.categoryLock([row("en_US", "APPROVED"), row("es", "REJECTED")])).toBeNull();
    expect(G.categoryLock([row("en_US", "PAUSED")])).toBeNull();
  });

  test("a mixed-category group opens clean: nothing is recategorized until the operator moves it", () => {
    const rows = [row("en_US", "REJECTED", { category: "MARKETING" }), row("es", "REJECTED")];
    const category = G.groupCategory(rows);
    const opened = tabs({ rows, category, initialCategory: category });
    expect(opened.map((tab) => tab.dirty)).toEqual([false, false]);
    expect(G.submission(opened)).toEqual([]);
  });

  test("a move re-submits only the languages Meta lets it change", () => {
    const moved = tabs({
      rows: [row("en_US", "APPROVED"), row("es", "REJECTED"), row("it", "PAUSED", { category: "MARKETING" })],
      category: "MARKETING",
      initialCategory: "UTILITY",
    });
    expect(moved.map((tab) => [tab.language, tab.recategorize])).toEqual([
      ["en_US", false],
      ["es", true],
      ["it", false],
    ]);
  });

  test("after a partial failure the refused language is still sent, and retried", () => {
    const rows = [row("en_US", "REJECTED"), row("es", "REJECTED")];
    const after = tabs({
      rows,
      category: "MARKETING",
      initialCategory: "UTILITY",
      languages: { en_US: { sent: ready("en_US") }, es: { error: refused } },
    });
    expect(G.categoryLock(rows)).toBeNull();
    const sending = G.submission(after);
    expect(sending.map((tab) => tab.language)).toEqual(["es"]);
    expect(G.barBlocker("edit", "order_update", sending)).toBeNull();
    expect(G.primaryLabel("edit", sending, "es")).toBe("Retry Español");
  });
});

describe("the primary action", () => {
  test("names what it sends", () => {
    const created = tabs({ rows: [], languages: { es: { added: true, draft: ready("es") }, en_US: { added: true, draft: ready("en_US") } } });
    expect(G.primaryLabel("create", G.submission(created), "es")).toBe("Create 2 languages");
    expect(G.primaryLabel("create", G.submission(created).slice(0, 1), "es")).toBe("Create template");
    const edited = tabs({ rows: [row("en_US", "APPROVED"), row("es", "APPROVED")], languages: { es: { draft: ready("es") } } });
    expect(G.primaryLabel("edit", G.submission(edited), "es")).toBe("Submit Español for review");
    const both = tabs({
      rows: [row("en_US", "APPROVED"), row("es", "APPROVED")],
      languages: { es: { draft: ready("es") }, en_US: { draft: ready("en_US") } },
    });
    expect(G.primaryLabel("edit", G.submission(both), "es")).toBe("Submit 2 languages for review");
  });

  test("the bar says what blocks it, or what is waiting", () => {
    const blocked = tabs({ rows: [], languages: { es: { added: true, draft: ready("es") }, en_US: { added: true } } });
    expect(G.barBlocker("create", "", G.submission(blocked))).toBe("Name the template before it can be created.");
    expect(G.barBlocker("create", "shipping_delay", G.submission(blocked))).toBe("English (US) needs a body before it can be created.");
    const edited = tabs({ rows: [row("es", "APPROVED")], languages: { es: { draft: ready("es") } } });
    expect(G.barNote("edit", G.submission(edited), [])).toBe("Español has unsent changes.");
  });
});

describe("the requests", () => {
  const shared = { wabaId: "WABA_A", name: "order_update", category: "MARKETING" as const };

  test("a language not at Meta is a create with the page's category", () => {
    const [tab] = tabs({ rows: [], languages: { es: { added: true, draft: ready("es") } } });
    expect(requestFor(tab!, shared)).toEqual({
      kind: "create",
      data: { wabaId: "WABA_A", name: "order_update", language: "es", category: "MARKETING", bodyText: ready("es").body },
    });
  });

  test("an edit carries the templateId, and the category only when it moves", () => {
    const [kept] = tabs({ rows: [row("es", "APPROVED")], languages: { es: { draft: ready("es") } } });
    expect(requestFor(kept!, shared)).toEqual({
      kind: "edit",
      data: { wabaId: "WABA_A", name: "order_update", language: "es", templateId: "id-es", bodyText: ready("es").body },
    });
    const [moved] = tabs({ rows: [row("es", "REJECTED")], category: "MARKETING", initialCategory: "UTILITY" });
    expect(requestFor(moved!, shared).data).toMatchObject({ templateId: "id-es", category: "MARKETING" });
  });

  test("Meta's answers read in the console's words, and a recategorization is reported", () => {
    expect(refusal({ ok: true, data: { ok: true, id: "1", status: "PENDING", category: "UTILITY" } }, createTemplateFailureCopy)).toBeNull();
    expect(refusal({ ok: true, data: { ok: false, code: "graph", detail: "Invalid parameter" } }, createTemplateFailureCopy)).toEqual({
      title: "Meta refused the template",
      detail: "Invalid parameter",
      secondary: "Invalid parameter",
    });
    expect(refusal({ ok: true, data: { ok: false, code: "not_found", detail: null } }, editTemplateFailureCopy)?.title).toBe("Template not found");
    const answer = { ok: true as const, data: { ok: true as const, id: "1", status: "PENDING", category: "MARKETING" } };
    expect(movedCategory(answer, "UTILITY")).toBe("MARKETING");
    expect(movedCategory(answer, "MARKETING")).toBeNull();
  });
});

describe("serial send", () => {
  test("one call per language, in order, stopping at the first refusal", async () => {
    const calls: string[] = [];
    const outcome = await submitSerially(["en_US", "es", "it"], async (language) => {
      calls.push(language);
      return language === "es" ? refused : null;
    });
    expect(calls).toEqual(["en_US", "es"]);
    expect(outcome.done).toEqual(["en_US"]);
    expect(outcome.failed).toEqual({ item: "es", notice: refused });
  });

  test("a call that throws keeps what was already created and counts as the failure", async () => {
    const outcome = await submitSerially(["en_US", "es", "it"], async (language) => {
      if (language === "es") throw new Error("network");
      return null;
    });
    expect(outcome.done).toEqual(["en_US"]);
    expect(outcome.failed).toEqual({ item: "es", notice: UNANSWERED });
  });

  test("where a create lands, always past the leave guard", () => {
    expect(afterCreate("shipping_delay", "W", 2, null)).toEqual({ to: "/templates", search: { wabaId: "W" }, ignoreBlocker: true });
    expect(afterCreate("shipping_delay", "W", 0, "en_US")).toBeNull();
    expect(afterCreate("shipping_delay", "W", 1, "es")).toEqual({
      to: "/templates/$name",
      params: { name: "shipping_delay" },
      search: { wabaId: "W", language: "es" },
      replace: true,
      ignoreBlocker: true,
    });
  });

  test("the edit page it lands on: created tabs in review, the failed one keeps its draft and its error", () => {
    const landed = tabs({
      rows: [],
      languages: { en_US: { added: true, sent: ready("en_US") }, es: { added: true, draft: ready("es"), error: refused } },
    });
    expect(landed.map((tab) => [tab.language, G.tabState(tab), Boolean(tab.readOnly)])).toEqual([
      ["en_US", "IN REVIEW", true],
      ["es", "NOT CREATED", false],
    ]);
    expect(G.barNote("edit", G.submission(landed), ["en_US"])).toBe("English (US) was created. Español was not.");
  });
});

describe("the leave guard", () => {
  const leaving = { current: { pathname: "/templates/new" }, next: { pathname: "/templates" } };
  const switching = { current: { pathname: "/templates/new" }, next: { pathname: "/templates/new" } };

  test("blocks leaving the page with unsent work, never a tab switch", () => {
    const armed = leaveBlocker(true);
    expect(armed.shouldBlockFn(leaving)).toBe(true);
    expect(armed.shouldBlockFn(switching)).toBe(false);
    expect(armed.enableBeforeUnload).toBe(true);
    expect(armed.withResolver).toBe(true);
    const idle = leaveBlocker(false);
    expect(idle.shouldBlockFn(leaving)).toBe(false);
    expect(idle.enableBeforeUnload).toBe(false);
  });

  test("the page wires it to its drafts", () => {
    renderEditor({ rows: [row("en_US", "APPROVED")], language: "en_US" });
    expect(blockerOpts?.enableBeforeUnload).toBe(false);
    renderEditor({ mode: "create", rows: [] });
    expect(blockerOpts?.shouldBlockFn(leaving)).toBe(false);
    // The draft a partial create handed over is unsent work: it arms both halves.
    putHandoff("order_update", {
      category: "UTILITY",
      languages: { en_US: { added: true, sent: ready("en_US") }, es: { added: true, draft: ready("es"), error: refused } },
      receipt: "English (US) sent to Meta for review. Meta categorized English (US) as MARKETING.",
    });
    const html = renderEditor({ rows: [], language: "es" });
    // What Meta said about the languages it took travels with the handoff.
    expect(html).toContain("Meta categorized English (US) as MARKETING.");
    dropHandoff("order_update");
    expect(blockerOpts?.enableBeforeUnload).toBe(true);
    expect(blockerOpts?.shouldBlockFn(leaving)).toBe(true);
    expect(blockerOpts?.shouldBlockFn(switching)).toBe(false);
  });
});

describe("the page", () => {
  test("creating: name, category, one tab in the account's most used language, no review list", () => {
    const html = renderEditor({
      mode: "create",
      rows: [row("es", "APPROVED"), { ...row("es", "APPROVED"), name: "b" }, row("en_US", "APPROVED")],
    });
    expect(html).toContain(">New template<");
    expect(html).toContain('id="template-name"');
    expect(html).toContain('aria-label="Español, es, incomplete"');
    expect(html).toContain(">Create template<");
    expect(html).not.toContain(">Meta review<");
    expect(html).toContain("Preview · Español");
    expect(html).toMatch(/<output[^>]*aria-live="polite"/);
  });

  test("duplicating pre-fills the source language's content and leaves the name empty", () => {
    const html = renderEditor({ mode: "create", rows: [row("es", "APPROVED")], from: "order_update", language: "es" });
    expect(html).toContain("Your order is on its way.");
    expect(html).toContain('value=""');
  });

  test("?add=1 opens a new language draft beside the ones at Meta", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED")], add: true });
    expect(html).toContain('aria-label="English (UK), en_GB, incomplete"');
  });

  test("editing: the name locked with its duplicate link, and the review list", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED"), row("es", "PENDING")], language: "en_US" });
    expect(html).toContain("Duplicate as new name");
    expect(html).toContain("Locked while a language is approved");
    expect(html).toContain(">Meta review<");
    expect(html).toContain("Add language");
  });

  test("a template the console cannot author offers no duplicate", () => {
    const html = renderEditor({
      rows: [row("en_US", "APPROVED", { components: [{ type: "BODY", text: "Hi" }, { type: "CAROUSEL", cards: [] }] })],
      language: "en_US",
    });
    expect(html).not.toContain("Duplicate as new name");
    expect(html).toContain("which the console does not author");
  });

  test("a rejected language beside an approved one keeps the category open, and says to which", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED"), row("es", "REJECTED")], language: "es" });
    expect(html).toContain("Applies to rejected and paused languages");
    expect(html).toContain('id="template-category"');
  });

  test("a language with its own category says so in the review list", () => {
    const html = renderEditor({
      rows: [row("en_US", "APPROVED"), row("es", "APPROVED"), row("it", "APPROVED", { category: "MARKETING" })],
      language: "en_US",
    });
    expect(html.slice(html.indexOf(">Meta review<"))).toContain(">Marketing<");
  });
});

function renderEditor(props: { mode?: "create" | "edit"; rows: unknown[]; language?: string; from?: string; add?: boolean }): string {
  return renderToStaticMarkup(
    <TemplateEditor
      mode={props.mode ?? "edit"}
      wabaId="WABA_A"
      businessName="Biz"
      phones={[]}
      rows={props.rows as never}
      name={props.mode === "create" ? undefined : "order_update"}
      language={props.language}
      from={props.from}
      add={props.add}
      onLanguage={() => {}}
    />,
  );
}
