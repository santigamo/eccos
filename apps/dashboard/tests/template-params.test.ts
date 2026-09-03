import { describe, expect, test } from "bun:test";
import {
  analyzeTemplate,
  canSendTemplate,
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
