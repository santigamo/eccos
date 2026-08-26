import { createFileRoute, Link } from "@tanstack/react-router";
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
import {
  COUNT_LINK,
  countTotal,
  Page,
  StatusCounts,
  StatusTag,
  Unreachable,
} from "../ui";

export const Route = createFileRoute("/")({
  loader: () => getGatewayStatus(),
  component: StatusPage,
});

/**
 * The banner a state raises. `null` means the state speaks for itself: healthy
 * needs no sentence, the tag beside the heading already says it.
 */
interface HealthBanner {
  detail: string;
  /**
   * Left rail of the banner. The semantic colour lives on the rail — a
   * neutral hairline there reads as decoration and says nothing.
   */
  rail: string;
}

interface HealthMeta {
  label: string;
  banner: HealthBanner | null;
}

const HEALTH_META: Record<Health, HealthMeta> = {
  healthy: {
    label: "Healthy",
    banner: null,
  },
  degraded: {
    label: "Degraded",
    banner: {
      detail: "The gateway is running with reduced capacity.",
      rail: "border-l-[#f0a020]",
    },
  },
  unhealthy: {
    label: "Unhealthy",
    banner: {
      detail: "The gateway is experiencing an outage.",
      rail: "border-l-[#e03131]",
    },
  },
};

const UNREACHABLE_META: HealthMeta = {
  label: "Unreachable",
  banner: {
    detail:
      "The dashboard could not reach the gateway over the GATEWAY service binding.",
    rail: "border-l-[#e03131]",
  },
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
      <StatusBanner banner={meta.banner} />
      {result.ok ? (
        <StatusView status={result.status} />
      ) : (
        <Unreachable error={result.error} />
      )}
    </Page>
  );
}

/**
 * The live region is always mounted and renders nothing while healthy: an
 * element that appears and disappears is not reliably announced, an empty one
 * that fills up is. Healthy therefore costs no pixels — no banner, no margin.
 */
function StatusBanner({ banner }: { banner: HealthBanner | null }) {
  return (
    <output
      className={
        banner
          ? cn(
              "mb-4 block border-l-2 px-3 py-2 text-sm text-foreground",
              banner.rail,
            )
          : undefined
      }
      aria-live="polite"
    >
      {banner?.detail}
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
      {/* hatch → facts, the landing's chapter opening: the pulse first,
          reference details after. */}
      <FactsStrip counts={counts} />

      {/* `fit`: the connection panel sizes to its four fields. Without it the
          panel grows to fill its frame and opens a hole under the list. */}
      <StatusPanel title="Connection" fit className="mt-6">
        <dl className="m-0 divide-y divide-(--frame-panel-border-color)">
          <Field label="WABA ID" value={connection.wabaId} />
          <Field label="Phone number ID" value={connection.phoneNumberId} />
          <Field label="Display phone" value={connection.displayPhone} />
          <Field label="Connected at" value={connection.connectedAt} />
        </dl>
      </StatusPanel>

      <p className="mt-auto pt-8 text-muted-foreground text-xs">
        {status.name} · v{status.version}
      </p>
    </>
  );
}

/**
 * The landing's facts strip: no boxes, no shadows — three cells that share the
 * page's rules and rails, so the numbers sit in the structure instead of
 * floating above it. Every figure is a door into the log that proves it.
 */
function FactsStrip({ counts }: { counts: GatewayStatus["counts"] }) {
  const outbound = countTotal(counts.outbound);
  const deliveries = countTotal(counts.deliveries);
  return (
    <section
      aria-label="Traffic at a glance"
      className="grid grid-cols-1 divide-y divide-(--line) border-y border-(--line) sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      <FactCell
        kicker="Inbound"
        caption="events received"
        total={
          <Link
            to="/inbound"
            aria-label={`${counts.inbound} inbound events received`}
            className={COUNT_LINK}
          >
            {counts.inbound}
          </Link>
        }
      />
      <FactCell
        kicker="Outbound"
        caption="messages sent"
        total={
          <Link
            to="/outbound"
            aria-label={`${outbound} outbound messages sent`}
            className={COUNT_LINK}
          >
            {outbound}
          </Link>
        }
      >
        <StatusCounts label="outbound" counts={counts.outbound} target="outbound" />
      </FactCell>
      <FactCell
        kicker="Deliveries"
        caption="forward attempts"
        total={
          <Link
            to="/deliveries"
            aria-label={`${deliveries} delivery forward attempts`}
            className={COUNT_LINK}
          >
            {deliveries}
          </Link>
        }
      >
        <StatusCounts
          label="deliveries"
          counts={counts.deliveries}
          target="deliveries"
        />
      </FactCell>
    </section>
  );
}

/**
 * `caption` is hidden from assistive tech on purpose: the stat link already
 * carries it in its accessible name, so screen readers hear it once.
 */
function FactCell({
  kicker,
  total,
  caption,
  children,
}: {
  kicker: string;
  total: ReactNode;
  caption: string;
  children?: ReactNode;
}) {
  return (
    <div className="p-5">
      <p className="font-pixel text-xs tracking-[0.04em] uppercase text-muted-foreground">
        {kicker}
      </p>
      <p className="mt-2 font-pixel text-4xl tabular-nums text-foreground">
        {total}
      </p>
      <p className="mt-1 text-muted-foreground text-sm" aria-hidden="true">
        {caption}
      </p>
      {children}
    </div>
  );
}

function StatusPanel({
  title,
  fit,
  className,
  children,
}: {
  title: string;
  fit?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Frame variant="default" spacing="sm" className={className}>
      <FramePanel fit={fit}>
        <FrameHeader>
          <FrameTitle className="font-pixel text-xs font-normal tracking-[0.04em] uppercase text-muted-foreground">
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
