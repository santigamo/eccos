import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rendering contract for one language's fields on the authoring page
 * (`components/templates/language-fields.tsx`), and the draft predicates behind
 * them (`lib/template-draft.ts`). The fields are fully controlled, so every
 * state renders without a browser.
 *
 * Design contract assertions (docs/DASHBOARD-DESIGN.md): square corners, the
 * Inter-uppercase-11px functional register on labels, and the ghost anatomy.
 */

const { LanguageFields, LanguageReadOnly } = await import("../src/components/templates/language-fields");
const {
  blankDraft,
  coreButtons,
  draftContent,
  exampleUrlFor,
  exampleValueOf,
  exampleValues,
  isDraftDirty,
  languageBlocker,
} = await import("../src/lib/template-draft");
const { discardDraftCopy } = await import("../src/components/templates/discard-draft-dialog");

type Draft = ReturnType<typeof blankDraft>;
const EMPTY = blankDraft("en_US");
const noop = () => {};

function render(draft: Partial<Draft> = {}): string {
  return renderToStaticMarkup(<LanguageFields wabaId="WABA_A" draft={{ ...EMPTY, ...draft }} onChange={noop} />);
}

describe("LanguageFields", () => {
  test("one example input per variable, derived from the body", () => {
    const two = render({ body: "Hi {{1}}, order {{2}} shipped." });
    expect(two).toContain('id="template-example-1"');
    expect(two).toContain('id="template-example-2"');
    expect(two).not.toContain('id="template-example-3"');
    expect(render({ body: "Welcome and congratulations!" })).not.toContain("template-example-");
  });

  test("the examples hang under the body on a left hairline, with no muted fill", () => {
    const html = render({ body: "Hi {{1}}" });
    const examples = html.slice(html.indexOf("Sample values") - 200, html.indexOf("Sample values"));
    expect(examples).toContain("border-l border-(--line)");
    expect(examples).not.toContain("bg-muted");
  });

  test("shrinking the body keeps the values typed for the variables that remain", () => {
    const draft = { ...EMPTY, body: "Hi {{1}}", examples: ["Ada", "A-1029"] };
    expect(exampleValues(draft)).toEqual(["Ada"]);
    expect(exampleValues({ ...draft, body: "Hi {{1}} {{2}}" })).toEqual(["Ada", "A-1029"]);
    const html = render(draft);
    expect(html).toContain('value="Ada"');
    expect(html).not.toContain("A-1029");
  });

  test("the body counts its characters against Meta's ceiling and offers the next variable", () => {
    const html = render({ body: "Hi {{1}}" });
    expect(html).toContain("8 / 1024");
    expect(html).toContain("Insert variable {{2}}");
  });

  test("a blocked body says why next to the field", () => {
    const html = render({ body: "Hi {{customer_name}}" });
    expect(html).toContain("Named parameters cannot be created here");
    expect(html).toContain('aria-invalid="true"');
  });

  test("review warnings render amber", () => {
    const html = render({ body: "{{1}} {{2}} {{3}}" });
    expect(html).toContain("text-warning-foreground");
    expect(html).toContain("start or end with a variable");
  });

  test("each button is one row: label, URL and remove", () => {
    const html = render({ buttons: [{ text: "Track", url: "https://e.com/track", example: "" }] });
    expect(html).toContain('aria-label="Button 1 label"');
    expect(html).toContain('aria-label="Button 1 URL"');
    expect(html).toContain('aria-label="Remove button 1"');
    expect(html).toContain("+ Add button");
  });

  test("a dynamic URL asks only for its {{1}} value; a static one asks for nothing", () => {
    const dynamic = render({ buttons: [{ text: "Status", url: "https://e.com/s/{{1}}", example: "4821" }] });
    expect(dynamic).toContain("Example {{1}}");
    expect(dynamic).toContain('value="4821"');
    expect(dynamic).not.toContain("Example URL");
    expect(render({ buttons: [{ text: "Track", url: "https://e.com/track", example: "" }] })).not.toContain(
      "Example {{1}}",
    );
  });

  test("an unclosed {{ is neither dynamic nor static: no example field, and core says why", () => {
    const draft = { ...EMPTY, body: "Hi there", buttons: [{ text: "Track", url: "https://x.com/{{1", example: "" }] };
    expect(render(draft)).not.toContain("Example {{1}}");
    expect(languageBlocker(draft, "created")).toBe("English (US): Button 1's URL has a {{ that is not closed.");
  });

  test("states the scope wall once, with the way out", () => {
    const html = render();
    expect(html).toContain("The console creates text templates");
    expect(html).toContain("waba_id=WABA_A");
  });

  test("labels wear the functional register (Inter uppercase 11px, tracking-wider)", () => {
    const html = render({ body: "Hi {{1}}" });
    expect(html).toContain("text-[11px]");
    expect(html).toContain("tracking-wider");
    expect(html).toContain("uppercase");
  });

  test("nothing rounds a corner", () => {
    const stripped = render({ body: "Hi {{1}}", buttons: [{ text: "a", url: "https://e.com", example: "" }] })
      .replace(/rounded-none/g, "")
      .replace(/rounded-\([^)]*\)/g, "")
      .replace(/rounded-\[[^\]]*\]/g, "");
    expect(stripped).not.toMatch(/rounded-/);
  });

  test("a read-only language shows every part as the form would, with no inputs", () => {
    const html = renderToStaticMarkup(
      <LanguageReadOnly
        content={{
          header: null,
          body: "Hi {{1}}",
          examples: [["{{1}}", "Laura"]],
          footer: "Paper Studio",
          buttons: [{ text: "Track", target: "https://e.com/o/{{1}}", example: "4821" }],
        }}
      />,
    );
    for (const part of ["Hi {{1}}", "Example {{1}}", "Laura", "Paper Studio", "Track", "https://e.com/o/{{1}}", "4821"]) {
      expect(html).toContain(part);
    }
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });
});

describe("the dynamic URL example", () => {
  test("the console builds the example URL from the template and the {{1}} value", () => {
    expect(exampleUrlFor("https://shop.example.com/orders/{{1}}", "4821")).toBe("https://shop.example.com/orders/4821");
    expect(exampleUrlFor("https://e.com/s?t={{1}}&x=1", " T ")).toBe("https://e.com/s?t=T&x=1");
    expect(exampleUrlFor("https://e.com/s/{{1}}", "")).toBe("");
    expect(exampleUrlFor("https://e.com/static", "x")).toBe("");
  });

  test("the value is taken literally, and a named variable is replaced too", () => {
    // A string replacement would read `$&` as "the match" and put {{1}} back in.
    expect(exampleUrlFor("https://x.com/t/{{1}}", "a$&b")).toBe("https://x.com/t/a$&b");
    expect(exampleUrlFor("https://x.com/t/{{1}}", "a$`b")).toBe("https://x.com/t/a$`b");
    expect(exampleUrlFor("https://x.com/{{code}}", "42")).toBe("https://x.com/42");
    expect(exampleUrlFor("https://x.com/t/{{1}}", "order 42/é")).toBe("https://x.com/t/order 42/é");
  });

  test("Meta's stored example reads back as the {{1}} value", () => {
    expect(exampleValueOf("https://e.com/orders/{{1}}", "https://e.com/orders/4821")).toBe("4821");
    expect(exampleValueOf("https://e.com/s?t={{1}}&x=1", "https://e.com/s?t=T&x=1")).toBe("T");
    expect(exampleValueOf("https://e.com/orders/{{1}}", "https://other.com/4821")).toBe("");
    expect(exampleValueOf("https://x.com/t/{{1}}", "4821")).toBe("");
    expect(exampleValueOf(" https://x.com/t/{{1}}", "https://x.com/t/4821")).toBe("4821");
  });

  test("the request and core's rules carry the built URL", () => {
    const draft = { ...EMPTY, body: "hi", buttons: [{ text: "Status", url: "https://e.com/s/{{1}}", example: "T" }] };
    expect(coreButtons(draft)).toEqual([{ text: "Status", url: "https://e.com/s/{{1}}", exampleUrl: "https://e.com/s/T" }]);
    expect(draftContent(draft).buttons).toEqual([{ text: "Status", url: "https://e.com/s/{{1}}", exampleUrl: "https://e.com/s/T" }]);
    // Without its value the button blocks, in core's words.
    const missing = { ...draft, buttons: [{ ...draft.buttons[0]!, example: "" }] };
    expect(languageBlocker(missing, "created")).toContain("needs an example URL");
  });
});

describe("languageBlocker", () => {
  test("names the language and the first thing missing", () => {
    expect(languageBlocker({ ...EMPTY, language: "es" }, "created")).toBe("Español needs a body before it can be created.");
    expect(languageBlocker({ ...EMPTY, body: "Hi {{1}}" }, "submitted")).toBe("English (US) needs an example for {{1}}.");
    expect(languageBlocker({ ...EMPTY, body: "Hi", footer: "Hi {{1}}" }, "created")).toContain("cannot contain variables");
    expect(languageBlocker({ ...EMPTY, body: "Hi {{1}} there, thanks", examples: ["Ada"] }, "created")).toBeNull();
  });
});

describe("the leave guard's predicates", () => {
  test("an untouched draft is not dirty", () => {
    expect(isDraftDirty(EMPTY)).toBe(false);
  });

  test("anything typed arms it; whitespace and a blank button row do not", () => {
    expect(isDraftDirty({ ...EMPTY, body: "Hi {{1}}" })).toBe(true);
    expect(isDraftDirty({ ...EMPTY, footer: "Powered by Eccos" })).toBe(true);
    expect(isDraftDirty({ ...EMPTY, examples: ["Ada"] })).toBe(true);
    expect(isDraftDirty({ ...EMPTY, body: "\n ", footer: " " })).toBe(false);
    expect(isDraftDirty({ ...EMPTY, buttons: [{ text: "", url: "", example: "" }] })).toBe(false);
  });

  test("a language at Meta is dirty only once it differs from Meta's copy", () => {
    const initial = { ...EMPTY, body: "Hi" };
    expect(isDraftDirty({ ...initial }, initial)).toBe(false);
    expect(isDraftDirty({ ...initial, body: "Hi!" }, initial)).toBe(true);
  });

  test("adding a variable and removing it again is not a change", () => {
    // The examples array only grows, so a raw comparison kept the language EDITED and submitted it.
    const initial = { ...EMPTY, body: "Hi there" };
    expect(isDraftDirty({ ...initial, examples: ["Ada"] }, initial)).toBe(false);
  });

  test("the discard question names what is lost, and says something else mid-submit", () => {
    expect(discardDraftCopy(false)).toContain("Nothing has been created yet");
    expect(discardDraftCopy(true)).toContain("still being submitted");
    expect(discardDraftCopy(false, true)).toContain("Nothing has been changed at Meta yet");
  });
});
