/** Link unfurlers need absolute og:url/og:image; the root head ships them
 * origin-relative so the console works on any host, and this resolves them
 * against the request origin. */
export function absolutizeUnfurlTags(response: Response, origin: string): Response {
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  return new HTMLRewriter()
    .on('meta[property="og:url"], meta[property="og:image"]', {
      element(el) {
        const content = el.getAttribute("content");
        if (content?.startsWith("/")) el.setAttribute("content", `${origin}${content}`);
      },
    })
    .transform(response);
}
