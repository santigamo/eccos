import { createFileRoute } from "@tanstack/react-router";
import { listInbound } from "../server/gateway";
import { Page, Unreachable, fmtTs, styles } from "../ui";

export const Route = createFileRoute("/inbound")({
  loader: () => listInbound(),
  component: InboundPage,
});

/** One-line human summary of a stored inbound event payload. */
function inboundSummary(payload: string): string {
  try {
    const ev = JSON.parse(payload) as Record<string, unknown>;
    if (typeof ev.text === "string") return ev.text;
    if (typeof ev.transportMessageId === "string") return ev.transportMessageId;
    return JSON.stringify(ev).slice(0, 140);
  } catch {
    return payload.slice(0, 140);
  }
}

function InboundPage() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <Page title="Inbound">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  const rows = result.data;
  return (
    <Page title="Inbound">
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Received</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td style={styles.empty} colSpan={3}>
                  No inbound events.
                </td>
              </tr>
            ) : (
              rows.map((e) => (
                <tr key={e.id}>
                  <td style={styles.tdMono}>{fmtTs(e.received_at)}</td>
                  <td style={styles.td}>{e.type}</td>
                  <td style={styles.td}>{inboundSummary(e.payload)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
