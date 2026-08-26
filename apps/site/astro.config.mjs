import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://eccos.chat",
  output: "static",
  i18n: {
    locales: ["es", "en"],
    defaultLocale: "es",
    routing: {
      prefixDefaultLocale: false,
    },
  },
  trailingSlash: "never",
  compressHTML: false,
  build: {
    format: "directory",
  },
});
