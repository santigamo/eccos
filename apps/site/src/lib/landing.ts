/**
 * The landings are published HTML fragments (page-content/landing*.html), but
 * the FAQ has to come from data so it cannot drift from the JSON-LD. So the
 * fragment carries a `<!-- faq -->` marker where the band belongs and the route
 * renders the component between the two halves.
 *
 * Throwing on a missing marker is deliberate: the alternative is a build that
 * quietly moves the FAQ to the bottom of the page.
 */
const MARKER = "<!-- faq -->";

export function splitAtFaq(content: string): [string, string] {
  const at = content.indexOf(MARKER);
  if (at === -1) {
    throw new Error(`landing content is missing the ${MARKER} marker`);
  }
  return [content.slice(0, at), content.slice(at + MARKER.length)];
}
