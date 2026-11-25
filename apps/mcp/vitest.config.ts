import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { defineConfig } from "vitest/config";

const COMPATIBILITY = { compatibilityDate: "2026-06-12", compatibilityFlags: ["nodejs_compat"] };

/** A stub entrypoint in TypeScript, transpiled for Miniflare (its imports are type-only). */
function stubWorker(name: string, path: string) {
  const contents = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  }).outputText;
  return { name, modules: [{ type: "ESModule" as const, path: path.replace(/\.ts$/, ".js"), contents }], ...COMPATIBILITY };
}

export default defineConfig({
  test: {
    include: ["tests/worker/**/*.spec.ts"],
    fileParallelism: false,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.vitest.jsonc" },
      miniflare: {
        workers: [
          stubWorker("eccos-dashboard", "tests/stubs/console.ts"),
          stubWorker("eccos", "tests/stubs/gateway.ts"),
        ],
      },
    }),
  ],
});
