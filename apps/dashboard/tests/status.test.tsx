import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CountTable } from "../src/ui";

describe("CountTable (Status page count maps)", () => {
  test("renders rows for each status with the count", () => {
    const html = renderToStaticMarkup(
      <CountTable label="deliveries" counts={{ delivered: 3, failed: 1 }} />,
    );
    expect(html).toContain("delivered");
    expect(html).toContain("3");
    expect(html).toContain("failed");
    expect(html).toContain("1");
  });

  test("renders an explicit empty state instead of an empty table", () => {
    const html = renderToStaticMarkup(<CountTable label="outbound" counts={{}} />);
    expect(html).toContain("No outbound recorded yet.");
    expect(html).not.toContain("<table");
  });
});
