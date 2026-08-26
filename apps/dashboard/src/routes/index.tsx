import { createFileRoute } from "@tanstack/react-router";
import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { Badge, type badgeVariants } from "../components/reui/badge";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import {
  getGatewayStatus,
  type GatewayStatus,
  type Health,
} from "../server/gateway";
import { CountTable, Page, Unreachable } from "../ui";

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
          <output className="text-muted-foreground text-sm" aria-live="polite">
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
      <StatusPanel title="Connection">
        <dl className="m-0 divide-y divide-(--frame-panel-border-color)">
          <Field label="WABA ID" value={connection.wabaId} />
          <Field label="Phone number ID" value={connection.phoneNumberId} />
          <Field label="Display phone" value={connection.displayPhone} />
          <Field label="Connected at" value={connection.connectedAt} />
        </dl>
      </StatusPanel>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatusPanel title="Inbound">
          <p className="m-0 text-3xl font-bold text-foreground tabular-nums">
            {counts.inbound}
          </p>
          <p className="text-muted-foreground text-sm">events received</p>
        </StatusPanel>
        <StatusPanel title="Outbound">
          <CountTable label="outbound" counts={counts.outbound} />
        </StatusPanel>
        <StatusPanel title="Deliveries">
          <CountTable label="deliveries" counts={counts.deliveries} />
        </StatusPanel>
      </div>

      <p className="mt-6 text-center text-muted-foreground text-xs">
        {status.name} · v{status.version}
      </p>
    </>
  );
}

function StatusPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Frame variant="ghost" spacing="sm" className="h-full">
      <FramePanel className="h-full">
        <FrameHeader>
          <FrameTitle className="font-pixel text-[11px] tracking-wider uppercase">
            {title}
          </FrameTitle>
        </FrameHeader>
        {children}
      </FramePanel>
    </Frame>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-right text-foreground text-sm break-all">{value ?? "\u2014"}</dd>
    </div>
  );
}
