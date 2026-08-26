import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import viteReact from "@vitejs/plugin-react";

// Cloudflare Workers target for TanStack Start.
// The `cloudflare` plugin runs the SSR build/preview inside workerd and wires
// the bindings from wrangler.jsonc; `viteEnvironment.name` must match the SSR
// environment ("ssr"). Order matters: cloudflare → tanstackStart → viteReact.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
