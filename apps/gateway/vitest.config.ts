import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_BINDINGS = {
  META_ACCESS_TOKEN: "test-access-token",
  META_PHONE_NUMBER_ID: "1234567890",
  META_WABA_ID: "WABA_TEST",
  META_APP_SECRET: "test-app-secret",
  META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
  ECCOS_API_KEY: "test-api-key",
  SUBSCRIBER_WEBHOOK_URL: "https://subscriber.test/webhook",
  SUBSCRIBER_SECRET: "test-subscriber-secret",
  META_APP_ID: "test-app-id",
  META_ES_CONFIG_ID: "test-config-id",
  FORWARD_MAX_ATTEMPTS: "3",
} as const;

export default defineConfig({
  test: {
    include: ["tests/worker/**/*.spec.ts"],
    fileParallelism: false,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.vitest.jsonc" },
      miniflare: { bindings: { ...TEST_BINDINGS } },
    }),
  ],
});
