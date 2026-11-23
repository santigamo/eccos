// Verification-only entry for the gateway Worker (see ../SKILL.md, "Launch").
// It runs the unmodified Worker from apps/gateway and reroutes two outbound hosts to
// the local fake (fake-meta.ts): Meta's Graph API and the reserved subscriber host.
// Nothing else differs from `wrangler dev` on apps/gateway/src/worker.ts.
import worker from "../../../../apps/gateway/src/worker";

export * from "../../../../apps/gateway/src/worker";

declare const __VERIFY_FAKE_ORIGIN__: string;

const REROUTED: Record<string, string> = {
  "graph.facebook.com": "/graph",
  "subscriber.eccos-verify.example": "/subscriber",
};

const realFetch = globalThis.fetch;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const prefix = REROUTED[url.hostname];
  if (prefix === undefined) return realFetch(request);
  return realFetch(new Request(`${__VERIFY_FAKE_ORIGIN__}${prefix}${url.pathname}${url.search}`, request));
}) as typeof fetch;

export default worker;
