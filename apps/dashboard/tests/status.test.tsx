import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusCounts, countTotal } from "../src/ui";

describe("Status page count maps", () => {
  test("countTotal sums a per-status map into the headline total", () => {
    expect(countTotal({ delivered: 3, failed: 1 })).toBe(4);
    expect(countTotal({})).toBe(0);
  });

  // StatusCounts with entries renders router Links, which need a RouterProvider;
  // the arithmetic is covered by countTotal above. Only the empty branch is
  // renderable standalone.
  test("StatusCounts renders an explicit empty state instead of a link row", () => {
    const html = renderToStaticMarkup(
      <StatusCounts label="outbound" counts={{}} target="outbound" />,
    );
    expect(html).toContain("No outbound recorded yet.");
    expect(html).not.toContain("<a");
  });
});
