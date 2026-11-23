import { describe, expect, it } from "bun:test";
import { validateTemplateDraft } from "@eccos/core/template-rules";
import {
  BUTTON_URL_TOO_LONG,
  HEADER_LINK_WHITESPACE,
  templateDraftRequest,
  templateEditRequest,
  templateSendRequest,
} from "../src/template-requests";

const draft = {
  name: "order_update",
  language: "en_US",
  category: "UTILITY",
  bodyText: "Hi {{1}}, your order is on its way.",
  bodyExamples: ["Ada"],
};

describe("template requests", () => {
  it("refuses a non-object request with the console's message", () => {
    for (const request of [templateDraftRequest, templateEditRequest, templateSendRequest]) {
      for (const bad of [null, undefined, [], "x", 3]) {
        expect(() => request(bad)).toThrow("invalid dashboard request");
      }
    }
  });

  it("returns exactly what the core rule returns", () => {
    const raw = { ...draft, language: " en_US ", bodyExamples: [" Ada "] };
    expect(templateDraftRequest(raw)).toEqual(validateTemplateDraft(raw));
    expect(templateEditRequest({ ...raw, templateId: " 555 " })).toMatchObject({ templateId: "555", language: "en_US" });
    expect(templateSendRequest({ templateName: " hello_world ", languageCode: " en_US ", bodyParams: [" Ada "] })).toEqual({
      templateName: "hello_world",
      languageCode: "en_US",
      bodyParams: ["Ada"],
    });
  });

  it("runs the core rule before the gateway's own bounds", () => {
    expect(() => templateDraftRequest({ ...draft, bodyText: "Hi {{name}}" })).toThrow(/Named parameters/);
    const longUrl = { text: "Go", url: `https://e.cc/${"x".repeat(2000)}` };
    expect(() => templateDraftRequest({ ...draft, buttons: [longUrl] })).toThrow(BUTTON_URL_TOO_LONG);
    expect(() => templateEditRequest({ ...draft, templateId: "555", buttons: [longUrl] })).toThrow(BUTTON_URL_TOO_LONG);
    expect(() =>
      templateSendRequest({
        templateName: "hello_world",
        languageCode: "en_US",
        headerMedia: { format: "image", link: "https://cdn.e.cc/a b.png" },
      }),
    ).toThrow(HEADER_LINK_WHITESPACE);
    expect(() =>
      templateSendRequest({
        templateName: "hello_world",
        languageCode: "en_US",
        headerMedia: { format: "image", link: "https://u:p@example.com/x.png" },
      }),
    ).toThrow("header media link must not carry credentials");
  });
});
