// Verification-only Vite config for the console (see ../SKILL.md, "Launch").
// launch copies it into the run directory beside a copy of wrangler.jsonc and a
// link to apps/dashboard/node_modules. It builds the same plugins as
// apps/dashboard/vite.config.ts, but the Cloudflare plugin reads the copied config,
// and wrangler reads .dev.vars and .env beside the config it is given, so a
// developer's own files in apps/dashboard never reach the verification stack.
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboard = process.env.VERIFY_DASHBOARD_DIR;
const run = process.env.VERIFY_RUN_DIR;
if (!dashboard || !run) throw new Error("start the console with verify-eccos launch");

export default defineConfig({
  root: dashboard,
  envDir: `${run}/dashboard`,
  resolve: { alias: { "@": `${dashboard}/src` } },
  plugins: [
    cloudflare({
      configPath: `${run}/dashboard/wrangler.json`,
      viteEnvironment: { name: "ssr" },
      persistState: { path: `${dashboard}/.wrangler/state` },
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
