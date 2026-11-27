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
        const comma = counts[section] > 0 ? "," : "";
        counts[section] += page.rows.length;
        yield `${comma}${page.rows.map((row) => JSON.stringify(row)).join(",")}`;
      }
      after = page.next;
    } while (after);
    yield "]";
  }
  yield `,"config":${JSON.stringify(await source.config())}}}`;
}

/** Streams the export; `onEnd` runs once, with how it ended, the rows read so far and, when a read failed, the error. */
export function exportStream(
  source: ExportSource,
  onEnd: (end: ExportEnd, counts: ExportCounts, error?: unknown) => void,
): ReadableStream<Uint8Array> {
  const counts = Object.fromEntries(EXPORT_SECTIONS.map((section) => [section, 0])) as ExportCounts;
  const chunks = exportJson(source, counts);
  const encoder = new TextEncoder();
  let ended = false;
  const end = (how: ExportEnd, error?: unknown) => {
    ended = true;
    onEnd(how, counts, error);
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        // The client left while this read was in flight: the stream is already closed.
        if (ended) return;
        if (done) {
          controller.close();
          end("done");
        } else controller.enqueue(encoder.encode(value));
      } catch (error) {
        if (ended) return;
        end("failed", error);
        controller.error(error);
      }
    },
    async cancel() {
      end("cancelled");
      await chunks.return(undefined);
    },
  });
}
