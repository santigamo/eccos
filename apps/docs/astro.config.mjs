import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://docs.eccos.chat",
  output: "static",
  trailingSlash: "never",
  build: { format: "directory" },
  integrations: [
    starlight({
      title: "Eccos Docs",
      description:
        "Documentation for the Eccos Cloud API: send WhatsApp messages over HTTP and receive messages and delivery statuses on your own webhook.",
      favicon: "/assets/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/assets/favicon-32.png", sizes: "32x32", type: "image/png" } },
        {
          tag: "link",
          attrs: { rel: "preload", href: "/assets/fonts/InterVariable.woff2", as: "font", type: "font/woff2", crossorigin: "" },
        },
      ],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/santigamo/eccos" }],
      editLink: { baseUrl: "https://github.com/santigamo/eccos/edit/main/apps/docs/" },
      customCss: ["./src/styles/brand.css"],
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      plugins: [
        starlightLinksValidator(),
        starlightLlmsTxt({
          projectName: "Eccos Cloud API",
          description:
            "Eccos is an open-source WhatsApp gateway on the official Meta Cloud API. These docs cover the hosted Eccos Cloud HTTP API: authentication, sending messages, idempotency, errors and rate limits, bulk sending, webhooks and the event reference.",
        }),
      ],
      sidebar: [
        { label: "Overview", slug: "" },
        { slug: "authentication" },
        { slug: "sending-messages" },
        { slug: "idempotency" },
        { slug: "errors-and-rate-limits" },
        { slug: "bulk-sending" },
        { slug: "webhooks" },
        { slug: "event-reference" },
        { slug: "data-endpoints" },
      ],
    }),
  ],
});
