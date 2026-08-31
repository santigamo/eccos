import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import { cn } from "@/lib/utils";
import type { DashboardScope, GatewayStatus, Health } from "../server/gateway";
import {
  COUNT_LINK,
  countTotal,
  Page,
  StatusCounts,
  StatusTag,
  Unreachable,
} from "../ui";

export const Route = createFileRoute("/")({
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

function StatusPage() {
  const result = useLoaderData({ from: "__root__" });

  if (!result.ok) {
    // Standalone main wrapper: the app shell only mounts for a ready gateway,
    // so this branch renders bare — give it the same page padding as the shell.
    return (
      <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
        <Page title="Status" kicker="Gateway">
          <Unreachable error={result.error} />
        </Page>
      </main>
    );
  }

  if (result.data.stage !== "ready") return null;

  const meta = HEALTH_META[result.data.status.health];

  return (
    <Page title="Status" kicker="Gateway" actions={<HealthBadge meta={meta} />}>
      <StatusBanner banner={meta.banner} />
      <StatusView status={result.data.status} scope={result.data.scope} />
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

function StatusView({ status, scope }: { status: GatewayStatus; scope: DashboardScope }) {
  const { connection, counts } = status;
  return (
    <>
      {/* hatch → facts, the landing's chapter opening: the pulse first,
          reference details after. */}
      <FactsStrip counts={counts} selectedWabaId={scope.selectedWabaId} />

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

      <ScopePanel scope={scope} />

      <p className="mt-auto pt-8 text-muted-foreground text-xs">
        {status.name} · v{status.version}
      </p>
    </>
  );
}

function ScopePanel({ scope }: { scope: DashboardScope }) {
  const account = scope.resources.account;
  return (
    <StatusPanel title="Scope" fit className="mt-6">
      <dl className="m-0 divide-y divide-(--frame-panel-border-color)">
        <Field label="Mode" value="Account scoped" />
        <Field label="Account" value={account?.name || null} />
        <Field label="Account ID" value={account?.accountId || scope.accountId} />
        <Field label="Selected WABA" value={scope.selectedWabaId} />
      </dl>
      <div className="border-t border-(--frame-panel-border-color) pt-3">
        <p className="text-muted-foreground text-xs uppercase tracking-wider">Registered WABAs and phones</p>
        <ul className="m-0 mt-3 list-none space-y-3 p-0">
          {scope.resources.wabas.map((waba) => (
            <li key={waba.wabaId}>
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
                <span className="font-mono text-xs">{waba.wabaId}</span>
                {waba.wabaId === scope.selectedWabaId ? (
                  <span className="text-muted-foreground text-[11px] uppercase tracking-wider">selected</span>
                ) : null}
              </p>
              <ul className="m-0 mt-1 list-none space-y-1 border-l border-(--line) pl-3 text-muted-foreground text-xs">
                {waba.phones.map((phone) => (
                  <li key={phone.phoneNumberId}>
                    <span className="font-mono">{phone.phoneNumberId}</span>
                    <span className="ml-2">{phone.displayPhoneNumber || "not labelled"}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </StatusPanel>
  );
}

/**
 * The landing's facts strip: no boxes, no shadows — three cells that share the
 * page's rules and rails, so the numbers sit in the structure instead of
 * floating above it. Every figure is a door into the log that proves it.
 */
function FactsStrip({ counts, selectedWabaId }: { counts: GatewayStatus["counts"]; selectedWabaId: string }) {
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
            search={{ wabaId: selectedWabaId }}
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
            search={{ wabaId: selectedWabaId }}
            aria-label={`${outbound} outbound messages sent`}
            className={COUNT_LINK}
          >
            {outbound}
          </Link>
        }
      >
        <StatusCounts label="outbound" counts={counts.outbound} target="outbound" wabaId={selectedWabaId} />
      </FactCell>
      <FactCell
        kicker="Deliveries"
        caption="forward attempts"
        total={
          <Link
            to="/deliveries"
            search={{ wabaId: selectedWabaId }}
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
          wabaId={selectedWabaId}
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
          <FrameTitle className="text-[11px] font-medium tracking-wider uppercase text-muted-foreground">
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
