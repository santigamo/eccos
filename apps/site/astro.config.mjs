import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

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
  // The sitemap is the other half of robots.txt: without it a crawler has to
  // guess that /en exists at all. `i18n` makes each page declare its
  // alternate-language twin, which is what stops the Spanish and English
  // landings from reading as duplicates.
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: "es",
        locales: { es: "es-ES", en: "en-US" },
      },
    }),
  ],
  trailingSlash: "never",
  compressHTML: false,
  build: {
    format: "directory",
  },
});
