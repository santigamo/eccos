import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_BINDINGS = {
  META_APP_SECRET: "test-app-secret",
  META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
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