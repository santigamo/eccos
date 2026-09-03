import { describe, expect, test } from "bun:test";
import {
  analyzeDraftBody,
  analyzeTemplate,
  canSendTemplate,
  draftWarnings,
  normalizeTemplateName,
  previewBody,
} from "../src/lib/template-params";

/**
 * What the "Send test" sheet is allowed to build (see
 * `src/lib/template-params.ts`).
 *
 * The scope is deliberately narrow — positional body parameters only — so the
 * job of these tests is to pin the BOUNDARY: every shape the sheet cannot
 * honestly render has to come back `unsupported` with a sentence, never as a
 * button that fails at Meta.
 *
 * Pure module, no `cloudflare:workers`, so it imports directly under bun test.
 */

const bodyComponent = (text: string) => ({ type: "BODY", text });

describe("analyzeTemplate", () => {
  test("hello_world (a TEXT header and no placeholders) is ready with zero inputs", () => {
    // The App Review screencast template. If this ever stops being sendable
    // there is nothing left to film.
    const result = analyzeTemplate({
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Hello World" },
        bodyComponent("Welcome and congratulations!"),
        { type: "FOOTER", text: "WhatsApp Business Platform sample message" },
      ],
    });
    expect(result).toEqual({
      kind: "ready",
      paramCount: 0,
      bodyText: "Welcome and congratulations!",
    });
  });

  test("counts positional body placeholders and keeps the body text for the preview", () => {
    const result = analyzeTemplate({
      components: [bodyComponent("Hi {{1}}, your order {{2}} shipped.")],
    });
    expect(result).toEqual({
      kind: "ready",
      paramCount: 2,
      bodyText: "Hi {{1}}, your order {{2}} shipped.",
    });
  });

  test("a row with no components at all is treated as zero-parameter", () => {
    // A DOCUMENTED GAMBLE. Meta's message_templates response is not ours to
    // control, and refusing to send a row whose `components` field is absent
    // would refuse hello_world on a shape change. Sent bare: if Meta wanted
    // parameters it answers 132000, which the gateway maps to a legible
    // "parameter_mismatch" line. This test exists so that stays a decision.
    expect(analyzeTemplate({ name: "hello_world" } as { components?: unknown })).toEqual({
      kind: "ready",
      paramCount: 0,
      bodyText: null,
    });
  });

  test("refuses named parameters, whether Meta declares them or the body shows them", () => {
    const declared = analyzeTemplate({
      parameter_format: "NAMED",
      components: [bodyComponent("Hi {{customer_name}}")],
    });
    const inferred = analyzeTemplate({
      components: [bodyComponent("Hi {{customer_name}}")],
    });
    for (const result of [declared, inferred]) {
      expect(result.kind).toBe("unsupported");
      if (result.kind === "unsupported") expect(result.reason).toContain("named parameters");
    }
  });

  test("refuses a media header, an authentication template, and a parameterised header", () => {
    const media = analyzeTemplate({
      components: [{ type: "HEADER", format: "IMAGE" }, bodyComponent("hi")],
    });
    const auth = analyzeTemplate({
      category: "AUTHENTICATION",
      components: [bodyComponent("{{1}} is your code")],
    });
    const header = analyzeTemplate({
      components: [{ type: "HEADER", format: "TEXT", text: "Order {{1}}" }, bodyComponent("hi")],
    });
    expect(media.kind).toBe("unsupported");
    expect(auth.kind).toBe("unsupported");
    expect(header.kind).toBe("unsupported");
    // Distinct reasons: each dead end has to say which one it is, or the
    // operator learns nothing from opening the sheet.
    const reasons = [media, auth, header].map((r) => (r.kind === "unsupported" ? r.reason : ""));
    expect(new Set(reasons).size).toBe(3);
  });

  test("refuses dynamic-URL, copy-code, OTP and flow buttons", () => {
    const cases = [
      { type: "URL", text: "Track", url: "https://example.com/{{1}}" },
      { type: "COPY_CODE", text: "Copy" },
      { type: "OTP", text: "Autofill" },
      { type: "FLOW", text: "Open" },
    ];
    for (const button of cases) {
      const result = analyzeTemplate({
        components: [bodyComponent("hi"), { type: "BUTTONS", buttons: [button] }],
      });
      expect(result.kind, button.type).toBe("unsupported");
    }
  });

  test("a static URL button does not disqualify a template", () => {
    // Buttons are only a problem when they carry something the console would
    // have to fill in; a fixed link is just part of the approved content.
    const result = analyzeTemplate({
      components: [
        bodyComponent("Hi {{1}}"),
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://example.com" }] },
      ],
    });
    expect(result).toMatchObject({ kind: "ready", paramCount: 1 });
  });

  test("refuses carousels and limited-time offers", () => {
    for (const type of ["CAROUSEL", "LIMITED_TIME_OFFER"]) {
      expect(analyzeTemplate({ components: [bodyComponent("hi"), { type }] }).kind, type).toBe(
        "unsupported",
      );
    }
  });

  test("refuses a gap in the positional numbering rather than guessing", () => {
    // {{1}} then {{3}} would make the sheet's inputs silently misalign with the
    // message that goes out.
    const result = analyzeTemplate({ components: [bodyComponent("Hi {{1}}, ref {{3}}")] });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.reason).toContain("gap");
  });
});

describe("canSendTemplate", () => {
  test("only an approved template can be sent", () => {
    expect(canSendTemplate("APPROVED")).toBe(true);
    expect(canSendTemplate("approved")).toBe(true);
    expect(canSendTemplate("PENDING")).toBe(false);
    expect(canSendTemplate("REJECTED")).toBe(false);
    expect(canSendTemplate(undefined)).toBe(false);
  });
});

describe("previewBody", () => {
  test("substitutes what is typed and leaves empty slots as their placeholder", () => {
    // The preview must never pretend a value exists: an unfilled slot keeps
    // {{n}} so what the operator sees is what Meta would receive.
    expect(previewBody("Hi {{1}}, order {{2}}", ["Ada", ""])).toBe("Hi Ada, order {{2}}");
  });
});

// --- Authoring (the "New template" sheet) ------------------------------------

describe("analyzeDraftBody", () => {
  test("accepts a plain body and counts positional variables", () => {
    // The create form's gate has to admit exactly what the send form's gate
    // admits: positional {{1}}..{{n}} and nothing else.
    expect(analyzeDraftBody("Welcome and congratulations!")).toEqual({ ok: true, paramCount: 0 });
    expect(analyzeDraftBody("Hi {{1}}, order {{2}} shipped.")).toEqual({ ok: true, paramCount: 2 });
    // A repeated variable is still one input — the same arithmetic
    // `analyzeTemplate` does on the row Meta returns.
    expect(analyzeDraftBody("Hi {{1}}, bye {{1}}.")).toEqual({ ok: true, paramCount: 1 });
  });

  test("blocks every draft the console could not later send", () => {
    // Each of these is either a Meta rule or the mirror of a refusal
    // `analyzeTemplate` already makes. A blocker carries a sentence, because
    // the submit button is disabled and the reason has to be on screen.
    const cases: [string, RegExp][] = [
      ["", /cannot be empty/],
      ["   ", /cannot be empty/],
      ["Hi {{customer_name}}", /Named parameters/],
      ["Hi {{1}}, ref {{3}}", /no gaps/],
      ["Hi {{0}}", /numbered from/],
      [`Hi ${Array.from({ length: 31 }, (_, i) => `{{${i + 1}}}`).join(" ")}`, /at most 30/],
      ["x".repeat(1025), /1024/],
    ];
    for (const [body, reason] of cases) {
      const result = analyzeDraftBody(body);
      expect(result.ok, JSON.stringify(body.slice(0, 30))).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    }
  });

  test("1024 characters exactly is still allowed", () => {
    // Meta's ceiling is inclusive; an off-by-one here would refuse a legal body.
    expect(analyzeDraftBody("x".repeat(1024))).toEqual({ ok: true, paramCount: 0 });
  });
});

describe("the agreement property (creation is the inverse of analysis)", () => {
  test("every draft the form accepts comes back from Meta as a sendable row", () => {
    // THE INVARIANT THIS WHOLE FEATURE RESTS ON. The console must never author
    // a template its own "Send test" sheet then refuses: what Meta stores is
    // the body typed here, and what the send sheet reads is `analyzeTemplate`
    // over that stored body. If this ever goes red, the scope boundary of the
    // create form has drifted away from the scope boundary of the send form —
    // fix the form, not this test.
    const drafts = [
      "Welcome and congratulations!",
      "Hi {{1}}, your order shipped.",
      "Hi {{1}}, order {{2}} ships on {{3}}.",
      "Hi {{1}}, bye {{1}}.",
      "{{1}}",
      "Line one\nline two {{1}}",
      "Spaced {{ 1 }} placeholder",
      "Padded {{01}} index",
      "Braces } and { on their own {{1}}",
      "Emoji ✅ and punctuation — {{1}}!",
      "x".repeat(1024),
      Array.from({ length: 30 }, (_, i) => `{{${i + 1}}}`).join(" "),
      // Blocked drafts belong in the corpus too: the property is "accepted
      // implies sendable", and a corpus with no refusals would not prove the
      // filter is doing anything.
      "Hi {{customer_name}}",
      "Hi {{1}}, ref {{3}}",
      "",
    ];

    let accepted = 0;
    for (const body of drafts) {
      const draft = analyzeDraftBody(body);
      if (!draft.ok) continue;
      accepted++;
      // The row Meta returns for a body-only template created this way.
      const row = analyzeTemplate({ components: [{ type: "BODY", text: body }] });
      expect(row.kind, body.slice(0, 40)).toBe("ready");
      if (row.kind === "ready") {
        expect(row.paramCount, body.slice(0, 40)).toBe(draft.paramCount);
        expect(row.bodyText).toBe(body);
      }
    }
    // Non-vacuity: a property that quantifies over an empty set proves nothing.
    expect(accepted).toBe(12);
  });

  test("the accepted parameter count is exactly the number of inputs the send sheet asks for", () => {
    // Stated separately because it is the operational consequence: the example
    // values collected at creation and the parameters collected at send time
    // are the same list, in the same order.
    for (let n = 0; n <= 5; n++) {
      const body = `Body ${Array.from({ length: n }, (_, i) => `{{${i + 1}}}`).join(" ")}`;
      const draft = analyzeDraftBody(body);
      expect(draft).toEqual({ ok: true, paramCount: n });
      expect(analyzeTemplate({ components: [{ type: "BODY", text: body }] })).toMatchObject({
        kind: "ready",
        paramCount: n,
      });
    }
  });
});

describe("draftWarnings", () => {
  test("flags the reseller-sourced review risks without blocking anything", () => {
    // These are heuristics reported by resellers, not rules Meta publishes —
    // which is precisely why they warn. The console does not wall an operator
    // out of a template on a rule it cannot source.
    expect(draftWarnings("{{1}} your order is ready for collection today")).toEqual([
      expect.stringContaining("start or end with a variable"),
    ]);
    expect(draftWarnings("Your order is ready, {{1}}")).toEqual([
      expect.stringContaining("start or end with a variable"),
    ]);
    expect(draftWarnings("{{1}} {{2}} {{3}}")).toHaveLength(2);
  });

  test("stays silent on a body that reads as a message", () => {
    expect(draftWarnings("Hi {{1}}, your Eccos order is on its way and arrives tomorrow.")).toEqual(
      [],
    );
    expect(draftWarnings("Welcome and congratulations!")).toEqual([]);
    // A blocked draft has a blocker to show; piling warnings on top of it would
    // bury the sentence that actually explains the disabled button.
    expect(draftWarnings("Hi {{customer_name}}")).toEqual([]);
  });
});

describe("normalizeTemplateName", () => {
  test("coerces what is typed into Meta's charset, idempotently", () => {
    // What the field shows is what the API receives: the operator never gets a
    // rejection for a character the form let them type.
    expect(normalizeTemplateName("Order Update!")).toBe("order_update");
    expect(normalizeTemplateName("  Envío  Confirmado  ")).toBe("_envo_confirmado_");
    expect(normalizeTemplateName("a-b.c")).toBe("abc");
    for (const raw of ["Order Update!", "  Envío  ", "a-b.c", "already_fine_1"]) {
      const once = normalizeTemplateName(raw);
      expect(normalizeTemplateName(once), raw).toBe(once);
      expect(once === "" || /^[a-z0-9_]{1,512}$/.test(once), raw).toBe(true);
    }
  });

  test("caps at Meta's 512-character name limit", () => {
    expect(normalizeTemplateName("a".repeat(600))).toHaveLength(512);
  });
});
