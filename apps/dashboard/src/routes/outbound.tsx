import { createFileRoute } from "@tanstack/react-router";
import { listOutbound } from "../server/gateway";
import { Page, StatusTag, Unreachable, fmtTs, styles } from "../ui";

export const Route = createFileRoute("/outbound")({
  loader: () => listOutbound(),
  component: OutboundPage,
});

function OutboundPage() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <Page title="Outbound">
        <Unreachable error={result.error} />
      </Page>
    );
  }

  const rows = result.data;
  return (
    <Page title="Outbound">
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Created</th>
              <th style={styles.th}>Recipient</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Transport ID</th>
              <th style={styles.th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td style={styles.empty} colSpan={5}>
                  No outbound messages.
                </td>
              </tr>
            ) : (
              rows.map((o) => (
                <tr key={o.id}>
                  <td style={styles.tdMono}>{fmtTs(o.created_at)}</td>
                  <td style={styles.td}>{o.recipient}</td>
                  <td style={styles.td}>
                    <StatusTag status={o.status} />
                  </td>
                  <td style={styles.tdMono}>{o.transport_message_id ?? "—"}</td>
                  <td style={styles.td}>{o.error ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
