/**
 * SPIKE (task 0.3): a Workers transport for @better-auth/cimd.
 *
 * Workers cannot resolve DNS and pin the address. What a Worker can do:
 * HTTPS only, GET/HEAD only, no redirects (returned to the caller, never followed), no credentials,
 * a time cap, a size cap, and the `global_fetch_strictly_public` compatibility flag, which makes
 * global fetch() refuse this zone's own Workers origin shortcuts and route over the public Internet.
 */
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

export const workersCimdFetch: typeof fetch = async (input, init) => {
  const request = new Request(input as RequestInfo, init as RequestInit);
  const url = new URL(request.url);
  console.info("SPIKE_CIMD_FETCH " + url.href);
  if (url.protocol !== "https:") throw new TypeError("CIMD transport requires an HTTPS URL");
  if (request.method !== "GET" && request.method !== "HEAD") throw new TypeError("CIMD transport supports only GET and HEAD");
  if (url.username || url.password) throw new TypeError("CIMD transport refuses credentials");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  // Finding: chatgpt.com answers 403 to a fetch without a User-Agent (workerd sends none by default).
  const headers = new Headers(request.headers);
  if (!headers.has("user-agent") && !(globalThis as { SPIKE_NO_UA?: boolean }).SPIKE_NO_UA) headers.set("user-agent", "Eccos-CIMD/0 (+https://eccos.chat)");
  console.info("SPIKE_CIMD_HEADERS " + JSON.stringify([...headers.keys()]));
  const response = await fetch(url.href, {
    method: request.method,
    headers,
    redirect: "manual",
    signal,
  });
  console.info("SPIKE_CIMD_RESPONSE " + JSON.stringify({ url: url.href, status: response.status, server: response.headers.get("server"), cfMitigated: response.headers.get("cf-mitigated"), contentType: response.headers.get("content-type") }));
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) {
    await response.body?.cancel();
    throw new TypeError("CIMD metadata resource too large");
  }
  if (!response.body) return response;
  let seen = 0;
  const capped = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_BYTES) controller.error(new TypeError("CIMD metadata resource too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(capped, { status: response.status, statusText: response.statusText, headers: response.headers });
};
