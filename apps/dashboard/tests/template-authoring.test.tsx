import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * The template authoring page (`/templates/new`, `/templates/$name`): the tab
 * model and its state words (`lib/template-group.ts`), the serial create and
 * where it lands (`lib/template-submit.ts`), and the page itself rendered with
 * the router hooks stubbed, the same approach as `templates-screen.test.tsx`.
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

const { buildTabs, leaveBlocker, primaryLabel, barBlocker, barNote, submission, tabState } = await import(
  "../src/lib/template-group"
);
const { afterCreate, createFailure, submitSerially } = await import("../src/lib/template-submit");
const { TemplateEditor } = await import("../src/components/templates/template-editor");
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
const NONE = { drafts: {}, added: [], submitted: {}, errors: {}, category: "UTILITY" as const };

describe("the tab's state word", () => {
  test("one word per situation, never a dot", () => {
    const tabs = buildTabs({
      ...NONE,
      rows: [
        row("en_US", "APPROVED"),
        row("es", "APPROVED"),
        row("it", "PENDING"),
        row("fr", "REJECTED"),
      ],
      drafts: { es: draft("es", "Tu pedido va en camino y llega mañana.") },
      added: ["de", "nl"],
      errors: { nl: { title: "Meta refused the template", detail: "x" } },
    });
    expect(tabs.map((tab) => [tab.language, tabState(tab)])).toEqual([
      ["en_US", null],
      ["es", "EDITED"],
      ["it", "IN REVIEW"],
      ["fr", "REJECTED"],
      ["de", "INCOMPLETE"],
      ["nl", "NOT CREATED"],
    ]);
  });

  test("an edited language that no longer passes the rules is INCOMPLETE", () => {
    const [tab] = buildTabs({ ...NONE, rows: [row("en_US", "APPROVED")], drafts: { en_US: draft("en_US", "") } });
    expect(tabState(tab!)).toBe("INCOMPLETE");
  });

  test("the state is in the tab's accessible name", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED"), row("it", "PENDING")], language: "en_US" });
    expect(html).toContain('aria-label="Italian, it, in review"');
    expect(html).toContain('aria-label="English (US), en_US"');
    expect(html).toContain(">IN REVIEW<");
  });
});

describe("a language in review", () => {
  test("is read-only, and the page shows no submit bar for it", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED"), row("it", "PENDING")], language: "it" });
    expect(html).toContain("Meta is reviewing Italian, usually for a few minutes.");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("for review</button>");
    expect(html).not.toContain(">Cancel<");
  });

  test("a language this page submitted reads as in review until the page is left", () => {
    const [tab] = buildTabs({ ...NONE, rows: [row("en_US", "APPROVED")], submitted: { en_US: ready("en_US") } });
    expect(tab?.status).toBe("PENDING");
    expect(tab?.readOnly).toContain("Meta is reviewing");
  });
});

describe("the primary action", () => {
  test("names what it sends", () => {
    const created = buildTabs({ ...NONE, rows: [], added: ["es", "en_US"], drafts: { es: ready("es"), en_US: ready("en_US") } });
    expect(primaryLabel("create", submission(created), "es")).toBe("Create 2 languages");
    expect(primaryLabel("create", submission(created).slice(0, 1), "es")).toBe("Create template");

    const edited = buildTabs({ ...NONE, rows: [row("en_US", "APPROVED"), row("es", "APPROVED")], drafts: { es: ready("es") } });
    expect(primaryLabel("edit", submission(edited), "es")).toBe("Submit Spanish for review");
    const both = buildTabs({
      ...NONE,
      rows: [row("en_US", "APPROVED"), row("es", "APPROVED")],
      drafts: { es: ready("es"), en_US: ready("en_US") },
    });
    expect(primaryLabel("edit", submission(both), "es")).toBe("Submit 2 languages for review");

    const failed = buildTabs({
      ...NONE,
      rows: [row("en_US", "PENDING")],
      added: ["es"],
      drafts: { es: ready("es") },
      errors: { es: { title: "t", detail: "d" } },
    });
    expect(primaryLabel("edit", submission(failed), "es")).toBe("Retry Spanish");
  });

  test("the bar says what blocks it, or what is waiting", () => {
    const blocked = buildTabs({ ...NONE, rows: [], added: ["es", "en_US"], drafts: { es: ready("es") } });
    expect(barBlocker("create", "", submission(blocked))).toBe("Name the template before it can be created.");
    expect(barBlocker("create", "shipping_delay", submission(blocked))).toBe(
      "English (US) needs a body before it can be created.",
    );
    const edited = buildTabs({ ...NONE, rows: [row("es", "APPROVED")], drafts: { es: ready("es") } });
    expect(barBlocker("edit", "order_update", submission(edited))).toBeNull();
    expect(barNote("edit", submission(edited), [])).toBe("Spanish has unsent changes.");
    const failed = buildTabs({
      ...NONE,
      rows: [],
      submitted: { en_US: ready("en_US") },
      added: ["es"],
      drafts: { es: ready("es") },
      errors: { es: { title: "t", detail: "d" } },
    });
    expect(barNote("edit", submission(failed), ["en_US"])).toBe("English (US) was created. Spanish was not.");
  });
});

describe("serial create with a partial failure", () => {
  const refusal = createFailure({ ok: true, data: { ok: false, code: "graph", detail: "Invalid parameter" } });

  test("one call per language, in order, stopping at the first refusal", async () => {
    const calls: string[] = [];
    const outcome = await submitSerially(["en_US", "es", "it"], async (language) => {
      calls.push(language);
      return language === "es" ? refusal : null;
    });
    expect(calls).toEqual(["en_US", "es"]);
    expect(outcome.done).toEqual(["en_US"]);
    expect(outcome.failed?.item).toBe("es");
    expect(outcome.failed?.notice).toEqual({
      title: "Meta refused the template",
      detail: "Invalid parameter",
      secondary: "Invalid parameter",
    });
  });

  test("where the page goes: the list, nowhere, or the template's own page on the failed language", () => {
    expect(afterCreate("shipping_delay", ["en_US", "es"], null)).toEqual({
      kind: "list",
      toast: {
        title: "shipping_delay submitted in 2 languages.",
        description: "Meta reviews each one, usually within minutes.",
      },
    });
    expect(afterCreate("shipping_delay", [], "en_US")).toEqual({ kind: "stay" });
    expect(afterCreate("shipping_delay", ["en_US"], "es")).toEqual({
      kind: "group",
      name: "shipping_delay",
      language: "es",
    });
  });

  test("the edit page it lands on: created tabs in review, the failed one keeps its draft and its error", () => {
    const tabs = buildTabs({
      ...NONE,
      rows: [],
      submitted: { en_US: ready("en_US") },
      added: ["es"],
      drafts: { es: ready("es") },
      errors: { es: refusal! },
    });
    expect(tabs.map((tab) => [tab.language, tabState(tab), Boolean(tab.readOnly)])).toEqual([
      ["en_US", "IN REVIEW", true],
      ["es", "NOT CREATED", false],
    ]);
    expect(tabs[1]?.draft.body).toBe(ready("es").body);
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
    renderEditor({ mode: "create", rows: [], from: undefined });
    expect(blockerOpts?.shouldBlockFn(leaving)).toBe(false);
    // The draft a partial create handed over is unsent work: it arms both halves.
    putHandoff("order_update", {
      category: "UTILITY",
      created: { en_US: ready("en_US") },
      pending: [ready("es")],
      error: { language: "es", notice: { title: "t", detail: "d" } },
    });
    renderEditor({ rows: [], language: "es" });
    dropHandoff("order_update");
    expect(blockerOpts?.enableBeforeUnload).toBe(true);
    expect(blockerOpts?.shouldBlockFn(leaving)).toBe(true);
    expect(blockerOpts?.shouldBlockFn(switching)).toBe(false);
  });
});

describe("the page", () => {
  test("creating: name, category, one tab in the account's most used language, no review list", () => {
    const html = renderEditor({ mode: "create", rows: [row("es", "APPROVED"), { ...row("es", "APPROVED"), name: "b" }, row("en_US", "APPROVED")] });
    expect(html).toContain(">New template<");
    expect(html).toContain('id="template-name"');
    expect(html).toContain('aria-label="Spanish, es, incomplete"');
    expect(html).toContain(">Create template<");
    expect(html).not.toContain(">Meta review<");
    expect(html).toContain("Preview · Spanish");
  });

  test("editing: the name locked with its duplicate link, and the review list", () => {
    const html = renderEditor({ rows: [row("en_US", "APPROVED"), row("es", "PENDING")], language: "en_US" });
    expect(html).toContain("Duplicate as new name");
    expect(html).toContain("Locked while a language is approved");
    expect(html).toContain(">Meta review<");
    expect(html).toContain("Add language");
  });

  test("a language with its own category says so in the review list", () => {
    const html = renderEditor({
      rows: [row("en_US", "APPROVED"), row("es", "APPROVED"), row("it", "APPROVED", { category: "MARKETING" })],
      language: "en_US",
    });
    const review = html.slice(html.indexOf(">Meta review<"));
    expect(review).toContain(">Marketing<");
  });
});

function renderEditor(props: {
  mode?: "create" | "edit";
  rows: unknown[];
  language?: string;
  from?: string;
}): string {
  return renderToStaticMarkup(
    <TemplateEditor
      mode={props.mode ?? "edit"}
      wabaId="WABA_A"
      businessName="Biz"
      rows={props.rows as never}
      name={props.mode === "create" ? undefined : "order_update"}
      language={props.language}
      from={props.from}
      onLanguage={() => {}}
    />,
  );
}
