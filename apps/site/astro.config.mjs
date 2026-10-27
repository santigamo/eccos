import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const here = fileURLToPath(new URL("./", import.meta.url));
const BUILD_DATE = new Date();

/**
 * When the served document last changed, taken from git rather than from file
 * mtimes — a fresh clone rewrites mtimes to checkout time, which would tell a
 * crawler that every page changed on every deploy. Falls back to the build date
 * if git is unavailable wherever the build runs.
 */
function lastModified(...paths) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", ...paths], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return new Date(out);
  } catch {
    // No git (or no history for these paths): the build date is the honest answer.
  }
  return BUILD_DATE;
}

// Every page renders through the layout, and the landings also render the FAQ
// out of the product data — so a change to those changes the document a crawler
// fetches, not just the source tree.
const SHELL = ["src/layouts/SiteLayout.astro"];
const LANDING_SHELL = [
  ...SHELL,
  "src/components/Faq.astro",
  "src/components/LandingSchema.astro",
  "src/data/product.ts",
];

const LASTMOD = {
  "/": lastModified("src/page-content/landing.es.html", "src/pages/index.astro", ...LANDING_SHELL),
  "/en": lastModified("src/page-content/landing.html", "src/pages/en/index.astro", ...LANDING_SHELL),
  "/migrate": lastModified("src/page-content/migrate.html", "src/pages/migrate.astro", ...SHELL),
  "/privacy": lastModified("src/page-content/privacy.html", "src/pages/privacy.astro", ...SHELL),
  "/terms": lastModified("src/page-content/terms.html", "src/pages/terms.astro", ...SHELL),
  "/data-deletion": lastModified(
    "src/page-content/data-deletion.html",
    "src/pages/data-deletion.astro",
    ...SHELL,
  ),
};

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
  // landings from reading as duplicates, and `lastmod` is the recrawl signal —
  // the only way a crawler learns that a page it already has was rewritten.
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: "es",
        locales: { es: "es-ES", en: "en-US" },
      },
      // /llms.txt is a brief for answer engines, not a page for the index.
      filter: (page) => !page.endsWith("/llms.txt"),
      serialize(item) {
        const path = new URL(item.url).pathname.replace(/\/$/, "") || "/";
        const lastmod = LASTMOD[path];
        if (lastmod) item.lastmod = lastmod.toISOString();
        return item;
      },
    }),
  ],
  trailingSlash: "never",
  compressHTML: false,
  build: {
    format: "directory",
  },
});
