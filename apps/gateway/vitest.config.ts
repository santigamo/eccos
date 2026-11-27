import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig, type Plugin } from "vitest/config";
import ts from "typescript";
import { fences } from "./tests/docs-md";
import { shards, weight } from "./tests/shards";

/** `--shard=i/n` splits by recorded duration, not file count, and each shard starts its slowest files first. */
class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    return shards(files, count, (spec) => spec.moduleId)[index - 1] ?? [];
  }

  override async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => weight(b.moduleId) - weight(a.moduleId));
  }
}

/** `page.md?ts-fence=N` imports the Nth ```ts block of a docs page as a module (docs-contract.spec.ts). */
const docsTsFence: Plugin = {
  name: "docs-ts-fence",
  enforce: "pre",
  load(id) {
    const match = id.match(/^(.*\.md)\?ts-fence=(\d+)$/);
    if (!match) return null;
    const block = fences(readFileSync(String(match[1]), "utf8")).filter(
      (f) => f.lang === "ts",
    )[Number(match[2])];
    if (!block) throw new Error(`no ts fence ${match[2]} in ${match[1]}`);
    return ts.transpileModule(block.code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
      },
    }).outputText;
  },
};

const TEST_BINDINGS = {
  META_APP_SECRET: "test-app-secret",
  META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
  META_APP_ID: "test-app-id",
  META_ES_CONFIG_ID: "test-config-id",
  GATEWAY_PUBLIC_URL: "https://gateway.example",
  FORWARD_MAX_ATTEMPTS: "3",
  // Fake, test-only key material for the control-plane token encryption.
  ECCOS_TOKEN_ENCRYPTION_KEY: "test-token-encryption-key-not-a-real-secret",
} as const;

export default defineConfig({
  test: {
    include: ["tests/worker/**/*.spec.ts"],
    sequence: { sequencer: DurationSequencer },
    // Files run in parallel, each in its own Miniflare. Every file re-imports the worker, so the
    // heavy dependencies are pre-bundled once: workerd then loads one module, not hundreds.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@sentry/cloudflare", "hono", "zod"],
          rolldownOptions: { external: [/^node:/, /^cloudflare:/] },
        },
      },
    },
  },
  plugins: [
    docsTsFence,
    cloudflareTest({
      wrangler: { configPath: "./wrangler.vitest.jsonc" },
      miniflare: { bindings: { ...TEST_BINDINGS } },
    }),
  ],
});
