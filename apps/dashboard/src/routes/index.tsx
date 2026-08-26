import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import { cn } from "@/lib/utils";
import {
  getGatewayStatus,
  type GatewayStatus,
  type Health,
} from "../server/gateway";
import { CountTable, Page, StatusTag, Unreachable } from "../ui";

export const Route = createFileRoute("/")({
  loader: () => getGatewayStatus(),
  component: StatusPage,
});

interface HealthMeta {
  label: string;
  detail: string;
  /**
   * Left rail of the banner. The semantic colour lives on the rail — a
   * neutral hairline there reads as decoration and says nothing.
   */
  rail: string;
}

const HEALTH_META: Record<Health, HealthMeta> = {
  healthy: {
    label: "Healthy",
    detail: "The gateway is operational.",
    rail: "border-l-[#25d366]",
  },
  degraded: {
    label: "Degraded",
    detail: "The gateway is running with reduced capacity.",
    rail: "border-l-[#f0a020]",
  },
  unhealthy: {
    label: "Unhealthy",
    detail: "The gateway is experiencing an outage.",
    rail: "border-l-[#e03131]",
  },
};

const UNREACHABLE_META: HealthMeta = {
  label: "Unreachable",
  detail: "The dashboard could not reach the gateway over the GATEWAY service binding.",
  rail: "border-l-[#e03131]",
};

function StatusPage() {
  const result = Route.useLoaderData();

  if (result === undefined) {
    return (
      <Page title="Status" kicker="Gateway">
        <output className="text-muted-foreground text-sm" aria-live="polite">
          Loading gateway status…
        </output>
      </Page>
    );
  }

  const meta = result.ok ? HEALTH_META[result.status.health] : UNREACHABLE_META;

  return (
    <Page title="Status" kicker="Gateway" actions={<HealthBadge meta={meta} />}>
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
      className={cn(
        "mb-4 block border-l-2 px-3 py-2 text-sm text-foreground",
        meta.rail,
      )}
      aria-live="polite"
    >
      {meta.detail}
    </output>
  );
}

function HealthBadge({ meta }: { meta: HealthMeta }) {
  return (
    <div className="flex items-center">
      <span className="sr-only">Gateway status: </span>
      <StatusTag status={meta.label} />
    </div>
  );
}

function StatusView({ status }: { status: GatewayStatus }) {
  const { connection, counts } = status;
  return (
    <>
      {/* `fit`: the connection panel sizes to its four fields. Without it the
          panel grows to fill its frame and opens a hole under the list. */}
      <StatusPanel title="Connection" fit>
        <dl className="m-0 divide-y divide-(--frame-panel-border-color)">
          <Field label="WABA ID" value={connection.wabaId} />
          <Field label="Phone number ID" value={connection.phoneNumberId} />
          <Field label="Display phone" value={connection.displayPhone} />
          <Field label="Connected at" value={connection.connectedAt} />
        </dl>
      </StatusPanel>

      {/* Grid cells stretch to the tallest row on their own, so the panels
          match height without an h-full chain. */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatusPanel title="Inbound">
          <p className="m-0 font-pixel text-4xl tabular-nums text-foreground">
            {counts.inbound}
          </p>
          <p className="mt-1 text-muted-foreground text-sm">events received</p>
        </StatusPanel>
        <StatusPanel title="Outbound">
          <CountTable label="outbound" counts={counts.outbound} />
        </StatusPanel>
        <StatusPanel title="Deliveries">
          <CountTable label="deliveries" counts={counts.deliveries} />
        </StatusPanel>
      </div>

      <p className="mt-auto pt-8 text-muted-foreground text-xs">
        {status.name} · v{status.version}
      </p>
    </>
  );
}

function StatusPanel({
  title,
  fit,
  children,
}: {
  title: string;
  fit?: boolean;
  children: ReactNode;
}) {
  return (
    <Frame variant="default" spacing="sm">
      <FramePanel fit={fit}>
        <FrameHeader>
          <FrameTitle className="font-pixel text-[11px] font-normal tracking-[0.04em] uppercase text-muted-foreground">
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
