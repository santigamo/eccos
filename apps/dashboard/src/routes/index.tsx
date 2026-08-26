import { createFileRoute } from "@tanstack/react-router";
import type { VariantProps } from "class-variance-authority";
import { Badge, type badgeVariants } from "../components/reui/badge";
import {
  getGatewayStatus,
  type GatewayStatus,
  type Health,
} from "../server/gateway";
import { CountTable, Page, Unreachable, styles } from "../ui";

export const Route = createFileRoute("/")({
  loader: () => getGatewayStatus(),
  component: StatusPage,
});

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

interface HealthMeta {
  variant: BadgeVariant;
  label: string;
  detail: string;
}

const HEALTH_META: Record<Health, HealthMeta> = {
  healthy: {
    variant: "success-light",
    label: "Healthy",
    detail: "The gateway is operational.",
  },
  degraded: {
    variant: "warning-light",
    label: "Degraded",
    detail: "The gateway is running with reduced capacity.",
  },
  unhealthy: {
    variant: "destructive-light",
    label: "Unhealthy",
    detail: "The gateway is experiencing an outage.",
  },
};

const UNREACHABLE_META: HealthMeta = {
  variant: "destructive-light",
  label: "Unreachable",
  detail: "The dashboard could not reach the gateway over the GATEWAY service binding.",
};

function StatusPage() {
  const result = Route.useLoaderData();

  if (result === undefined) {
    return (
      <Page title="Status">
          <output className={styles.muted} aria-live="polite">
            Loading gateway status…
          </output>
      </Page>
    );
  }

  const meta = result.ok ? HEALTH_META[result.status.health] : UNREACHABLE_META;

  return (
    <Page
      title="Status"
      actions={<HealthBadge meta={meta} />}
    >
      <StatusBanner meta={meta} />
      {result.ok ? (
        <StatusView status={result.status} />
      ) : (
        <Unreachable error={result.error} />
      )}
    </Page>
  );
}

function StatusBanner({ meta }: { meta: HealthMeta }) {
  return (
    <output
      className="mb-4 border-l-2 border-(--frame-panel-border-color) px-3 py-2 text-sm text-foreground"
      aria-live="polite"
    >
      {meta.detail}
    </output>
  );
}

function HealthBadge({ meta }: { meta: HealthMeta }) {
  return (
    <Badge variant={meta.variant} className="uppercase">
      <span className="sr-only">Gateway status: </span>
      {meta.label}
    </Badge>
  );
}

function StatusView({ status }: { status: GatewayStatus }) {
  const { connection, counts } = status;
  return (
    <>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Connection</h2>
        <dl className={styles.dl}>
          <Field label="WABA ID" value={connection.wabaId} />
          <Field label="Phone number ID" value={connection.phoneNumberId} />
          <Field label="Display phone" value={connection.displayPhone} />
          <Field label="Connected at" value={connection.connectedAt} />
        </dl>
      </section>

      <section className={styles.grid}>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Inbound</h2>
          <p className={styles.bigNumber}>{counts.inbound}</p>
          <p className={styles.muted}>events received</p>
        </div>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Outbound</h2>
          <CountTable label="outbound" counts={counts.outbound} />
        </div>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Deliveries</h2>
          <CountTable label="deliveries" counts={counts.deliveries} />
        </div>
      </section>

      <p className={styles.footer}>
        {status.name} · v{status.version}
      </p>
    </>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={styles.field}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={styles.fieldValue}>{value ?? "\u2014"}</dd>
    </div>
  );
}
