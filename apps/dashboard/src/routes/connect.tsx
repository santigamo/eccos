import { createFileRoute } from "@tanstack/react-router";
import { ConnectLinkLanding } from "../components/connect-link/landing";
import { copyFor, pickLanguage } from "../lib/connect-link/language";
import { getConnectLinkLanguage } from "../server/connect-link-language";

/**
 * The connection-link landing page: public, and the one page of the console
 * that is not English-only. The token rides in the URL fragment, so loading
 * this page sends it nowhere and changes nothing.
 */
export const Route = createFileRoute("/connect")({
  // Server-rendered from Accept-Language; a client-side run has no request to read.
  loader: () => getConnectLinkLanguage().catch(() => pickLanguage(globalThis.navigator?.language)),
  staleTime: Number.POSITIVE_INFINITY,
  head: ({ loaderData }) => {
    const copy = copyFor(loaderData ?? "en");
    return {
      meta: [
        { title: `${copy.pageTitle} · Eccos` },
        { name: "description", content: copy.summary },
        { property: "og:title", content: copy.pageTitle },
        { property: "og:description", content: copy.summary },
        { name: "robots", content: "noindex" },
        { name: "referrer", content: "no-referrer" },
      ],
    };
  },
  component: ConnectLinkPage,
});

function ConnectLinkPage() {
  return <ConnectLinkLanding copy={copyFor(Route.useLoaderData())} />;
}
