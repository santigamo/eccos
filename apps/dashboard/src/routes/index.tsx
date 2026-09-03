import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import { cn } from "@/lib/utils";
import { healthReading, type HealthBanner, type HealthReading } from "../lib/health";
import type { DashboardScope, GatewayStatus } from "../server/gateway";
import {
  COUNT_LINK,
  countTotal,
  FactCell,
  FactsStrip,
  Page,
  StatusCounts,
  StatusTag,
} from "../ui";
import { FailureView } from "../components/dashboard/failure";

export const Route = createFileRoute("/")({
  component: StatusPage,
});

/* What each health state says — including the case where the word alone gets it
   wrong (held events, no forwarding target) — lives in `lib/health.ts`, pure. */

function StatusPage() {
  const result = useLoaderData({ from: "__root__" });

  if (!result.ok) {
    // Standalone main wrapper: the app shell only mounts for a ready gateway,
    // so this branch renders bare — give it the same page padding as the shell.
    return (
      <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
        <Page title="Status" kicker="Gateway">
          <FailureView failure={result} />
        </Page>
      </main>
    );
  }

  if (result.data.stage !== "ready") return null;

  const reading = healthReading(result.data.status, result.hasForwardingTarget);

  return (
    <Page title="Status" kicker="Gateway" actions={<HealthBadge reading={reading} />}>
      <StatusBanner banner={reading.banner} wabaId={result.data.scope.selectedWabaId} />
      <StatusView status={result.data.status} scope={result.data.scope} />
    </Page>
  );
}

/**
 * The live region is always mounted and renders nothing while healthy: an
 * element that appears and disappears is not reliably announced, an empty one
 * that fills up is. Healthy therefore costs no pixels — no banner, no margin.
 */
function StatusBanner({ banner, wabaId }: { banner: HealthBanner | null; wabaId: string }) {
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
      {/* Data rule 2, applied to a state instead of a number: a banner naming a
          state the operator can resolve carries the door to it. The scope rides
          along, like every other link on this page — a target is per WABA. */}
      {banner?.action ? (
        <>
          {" "}
          <Link
            to={banner.action.to}
            search={{ wabaId }}
            // The house link idiom (the `link` button variant): green ink, the
            // console's interactivity signature, underlined on hover, green
            // ring on focus.
            className="text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {banner.action.label}
          </Link>
        </>
      ) : null}
    </output>
  );
}

function HealthBadge({ reading }: { reading: HealthReading }) {
  return (
    <div className="flex items-center">
      <span className="sr-only">Gateway status: </span>
      <StatusTag status={reading.label} />
    </div>
  );
}

function StatusView({ status, scope }: { status: GatewayStatus; scope: DashboardScope }) {
  const { connection, counts } = status;
  return (
    <>
      <FactsStripSection counts={counts} selectedWabaId={scope.selectedWabaId} />

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
 * The strip that opens the page: hatch then facts, the landing's chapter
 * opening — the pulse first, reference details after. The cells themselves are
 * the shared house idiom (`FactCell` in `src/ui.tsx`); every figure is a door
 * into the log that proves it.
 */
function FactsStripSection({ counts, selectedWabaId }: { counts: GatewayStatus["counts"]; selectedWabaId: string }) {
  const outbound = countTotal(counts.outbound);
  const deliveries = countTotal(counts.deliveries);
  return (
    <FactsStrip label="Traffic at a glance">
      <FactCell
        kicker="Inbound"
        caption="events received"
        value={
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
        value={
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
        value={
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
    </FactsStrip>
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
