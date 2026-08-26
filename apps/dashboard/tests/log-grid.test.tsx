import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createColumnHelper } from "@tanstack/react-table";
import { LogGrid } from "../src/components/grid/log-grid";
import type { DataGridFeatures } from "../src/components/reui/data-grid/data-grid";

interface Row {
  id: number;
  label: string;
  status?: string;
}

const helper = createColumnHelper<DataGridFeatures, Row>();
const columns = [
  helper.accessor("id", { id: "id", header: "ID" }),
  helper.accessor("label", { id: "label", header: "Label" }),
];

describe("LogGrid (shared ReUI Data Grid wrapper for log views)", () => {
  test("renders a contained scroll region around the grid", () => {
    const html = renderToStaticMarkup(
      <LogGrid columns={columns} data={[]} getRowId={(row) => String(row.id)} />,
    );
    expect(html).toContain('data-slot="data-grid-scroll-area"');
    expect(html).toContain('data-slot="data-grid"');
    expect(html).toContain('data-slot="data-grid-table"');
  });

  test("renders data rows with stable data-row-id attributes", () => {
    const html = renderToStaticMarkup(
      <LogGrid
        columns={columns}
        data={[
          { id: 7, label: "alpha" },
          { id: 42, label: "beta" },
        ]}
        getRowId={(row) => String(row.id)}
      />,
    );
    expect(html).toContain('data-row-id="7"');
    expect(html).toContain('data-row-id="42"');
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  test("renders a custom empty message with no rows", () => {
    const html = renderToStaticMarkup(
      <LogGrid
        columns={columns}
        data={[]}
        emptyMessage="No deliveries."
        getRowId={(row) => String(row.id)}
      />,
    );
    expect(html).toContain("No deliveries.");
  });

  test("dense square layout is applied to the table via tableLayout props", () => {
    const html = renderToStaticMarkup(
      <LogGrid
        columns={columns}
        data={[{ id: 1, label: "row" }]}
        getRowId={(row) => String(row.id)}
      />,
    );
    expect(html).toContain("h-8");
    expect(html).toContain("py-1.5");
  });
});
