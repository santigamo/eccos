import { describe, it, expect } from "bun:test";
import { overlayDoConfig } from "../src/config";
import type { CoreConfig } from "@eccos/core/config-schema";

const BASE: CoreConfig = {
  META_GRAPH_VERSION: "v24.0",
  META_ACCESS_TOKEN: "token",
  META_PHONE_NUMBER_ID: "env-phone",
  META_WABA_ID: "env-waba",
  META_APP_SECRET: "secret",
  META_WEBHOOK_VERIFY_TOKEN: "verify",
  ECCOS_API_KEY: "api-key",
  FORWARD_MAX_ATTEMPTS: 6,
};

describe("overlayDoConfig", () => {
  it("returns env config when DO has no stored ids", () => {
    expect(overlayDoConfig(BASE, {})).toEqual(BASE);
  });

  it("overrides env seeds with DO storage (D5)", () => {
    expect(
      overlayDoConfig(BASE, {
        META_WABA_ID: "do-waba",
        META_PHONE_NUMBER_ID: "do-phone",
      }),
    ).toEqual({
      ...BASE,
      META_WABA_ID: "do-waba",
      META_PHONE_NUMBER_ID: "do-phone",
    });
  });

  it("overrides only keys present in DO storage", () => {
    expect(overlayDoConfig(BASE, { META_PHONE_NUMBER_ID: "do-phone" })).toEqual({
      ...BASE,
      META_PHONE_NUMBER_ID: "do-phone",
    });
  });
});
