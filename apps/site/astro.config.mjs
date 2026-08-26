import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://eccos.chat",
  output: "static",
  trailingSlash: "never",
  compressHTML: false,
  build: {
    format: "directory",
  },
});
