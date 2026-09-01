import { describe, it, expect } from "bun:test";
import {
  gatewayObjectName,
  normalizeWabaId,
  resolveDoJurisdiction,
} from "../src/gateway-stub";
import { getAppConfig, tenantConfig } from "../src/tenant-config";
import { parseCoreConfig, type CoreConfig } from "@eccos/core/config-schema";

const BASE: CoreConfig = {
  META_GRAPH_VERSION: "v25.0",
  META_ACCESS_TOKEN: "token",
  META_PHONE_NUMBER_ID: "env-phone",
  META_WABA_ID: "env-waba",
  META_APP_SECRET: "secret",
  META_WEBHOOK_VERIFY_TOKEN: "verify",
  ECCOS_API_KEY: "api-key",
  FORWARD_MAX_ATTEMPTS: 6,
};

describe("resolveDoJurisdiction", () => {
  it("returns undefined when unset, empty, or blank (current behavior preserved)", () => {
    expect(resolveDoJurisdiction({})).toBeUndefined();
    expect(resolveDoJurisdiction({ DO_JURISDICTION: "" })).toBeUndefined();
    expect(resolveDoJurisdiction({ DO_JURISDICTION: "   " })).toBeUndefined();
  });

  it("accepts the jurisdictions Cloudflare supports", () => {
    expect(resolveDoJurisdiction({ DO_JURISDICTION: "eu" })).toBe("eu");
    expect(resolveDoJurisdiction({ DO_JURISDICTION: "fedramp" })).toBe("fedramp");
    expect(resolveDoJurisdiction({ DO_JURISDICTION: "fedramp-high" })).toBe("fedramp-high");
  });

  it("fails loudly on invalid values instead of silently ignoring them", () => {
    expect(() => resolveDoJurisdiction({ DO_JURISDICTION: "us" })).toThrow(/Invalid DO_JURISDICTION "us"/);
    expect(() => resolveDoJurisdiction({ DO_JURISDICTION: "us" })).toThrow(/no "us" jurisdiction/);
    expect(() => resolveDoJurisdiction({ DO_JURISDICTION: "EU" })).toThrow(/Invalid DO_JURISDICTION/);
    expect(() => resolveDoJurisdiction({ DO_JURISDICTION: "europe" })).toThrow(/does NOT migrate data/);
  });
});

describe("tenant routing", () => {
  it("uses an immutable versioned WABA key with jurisdiction included", () => {
    expect(gatewayObjectName(" WABA_123 ", "eu")).toBe("v1:eu:waba:WABA_123");
    expect(gatewayObjectName("WABA_123", undefined)).toBe("v1:auto:waba:WABA_123");
  });

  it("rejects empty or unsafe WABA ids", () => {
    expect(() => normalizeWabaId(" ")).toThrow(/Invalid WABA ID/);
    expect(() => normalizeWabaId("waba/123")).toThrow(/Invalid WABA ID/);
  });
});

describe("app config (account-scoped worker)", () => {
  const env = (overrides: Record<string, string | undefined> = {}) =>
    ({
      META_GRAPH_VERSION: "v25.0",
      META_APP_SECRET: "app-secret",
      META_WEBHOOK_VERIFY_TOKEN: "verify-token",
      META_APP_ID: "app-id",
      META_ES_CONFIG_ID: "es-config",
      ...overrides,
    }) as unknown as Env;

  it("requires only the Meta signature/verify secrets", () => {
    expect(getAppConfig(env({ META_APP_ID: "", META_ES_CONFIG_ID: "" }))).toMatchObject({
      META_GRAPH_VERSION: "v25.0",
      META_APP_SECRET: "app-secret",
      META_WEBHOOK_VERIFY_TOKEN: "verify-token",
    });
    expect(() => getAppConfig(env({ META_APP_SECRET: "" }))).toThrow(/META_APP_SECRET is required/);
    expect(() => getAppConfig(env({ META_WEBHOOK_VERIFY_TOKEN: "" }))).toThrow(/META_WEBHOOK_VERIFY_TOKEN is required/);
  });

  it("resolves a per-WABA tenant config from registry credentials", () => {
    const cfg = tenantConfig(getAppConfig(env({})), {
      wabaId: "WABA_T",
      phoneNumberId: "PN_T",
      metaAccessToken: "tenant-token",
    });
    expect(cfg).toMatchObject({
      META_GRAPH_VERSION: "v25.0",
      META_WABA_ID: "WABA_T",
      META_PHONE_NUMBER_ID: "PN_T",
      META_ACCESS_TOKEN: "tenant-token",
      META_APP_SECRET: "app-secret",
      META_WEBHOOK_VERIFY_TOKEN: "verify-token",
    });
  });
});

describe("coreSchema DO_JURISDICTION", () => {
  const REQUIRED = {
    META_ACCESS_TOKEN: "token",
    META_PHONE_NUMBER_ID: "phone",
    META_WABA_ID: "waba",
    META_APP_SECRET: "secret",
    META_WEBHOOK_VERIFY_TOKEN: "verify",
    ECCOS_API_KEY: "api-key",
  };

  it("accepts a supported jurisdiction and treats empty as unset", () => {
    expect(parseCoreConfig({ ...REQUIRED, DO_JURISDICTION: "eu" }).DO_JURISDICTION).toBe("eu");
    expect(parseCoreConfig({ ...REQUIRED, DO_JURISDICTION: "" }).DO_JURISDICTION).toBeUndefined();
    expect(parseCoreConfig(REQUIRED).DO_JURISDICTION).toBeUndefined();
  });

  it("rejects unsupported jurisdictions at config-parse time", () => {
    expect(() => parseCoreConfig({ ...REQUIRED, DO_JURISDICTION: "us" })).toThrow(/DO_JURISDICTION/);
  });
});
