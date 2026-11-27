/**
 * The HTTP export's body, streamed: `{"ok":true,"data":{...}}` exactly as one `JSON.stringify` of
 * the whole export would write it, pulled one short Durable Object read at a time. Sections are
 * read one after another, so the export is not one snapshot across tables.
 */
import { EXPORT_SECTIONS, type ExportCursor, type ExportPage, type ExportSection } from "./export-pages";

export interface ExportSource {
  page(section: ExportSection, after: ExportCursor | null): Promise<ExportPage>;
  config(): Promise<Record<string, string>>;
}

export type ExportCounts = Record<ExportSection, number>;
export type ExportEnd = "done" | "cancelled" | "failed";

export async function* exportJson(source: ExportSource, counts: ExportCounts): AsyncGenerator<string> {
  yield '{"ok":true,"data":{';
  for (const [index, section] of EXPORT_SECTIONS.entries()) {
    yield `${index > 0 ? "," : ""}${JSON.stringify(section)}:[`;
    let after: ExportCursor | null = null;
    do {
      const page: ExportPage = await source.page(section, after);
      if (page.rows.length > 0) {
        yield `${counts[section] > 0 ? "," : ""}${page.rows.map((row) => JSON.stringify(row)).join(",")}`;
        counts[section] += page.rows.length;
      }
      after = page.next;
    } while (after);
    yield "]";
  }
  yield `,"config":${JSON.stringify(await source.config())}}}`;
}

/** Streams the export; `onEnd` gets how it ended, the rows sent so far and, when a read failed, the error. */
export function exportStream(
  source: ExportSource,
  onEnd: (end: ExportEnd, counts: ExportCounts, error?: unknown) => void,
): ReadableStream<Uint8Array> {
  const counts = Object.fromEntries(EXPORT_SECTIONS.map((section) => [section, 0])) as ExportCounts;
  const chunks = exportJson(source, counts);
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) {
          controller.close();
          onEnd("done", counts);
        } else controller.enqueue(encoder.encode(value));
      } catch (error) {
        onEnd("failed", counts, error);
        controller.error(error);
      }
    },
    async cancel() {
      onEnd("cancelled", counts);
      await chunks.return(undefined);
    },
  });
}
