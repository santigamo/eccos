import { createFileRoute, Link, useLoaderData, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { getSubscriberConfig } from "../server/gateway";
import type { OperatorCounts, Result, SubscriberConfig } from "../server/gateway";
import {
  COUNT_LINK,
  FactCell,
  FactsStrip,
  Page,
  StatusCounts,
  StatusTag,
  countTotal,
  fmtTs,
  fmtTsShort,
} from "../ui";
import { cn } from "@/lib/utils";
import { FailureView } from "../components/dashboard/failure";
import { ForwardingTargetPanel } from "../components/dashboard/forwarding-target";
import { ResubscribeAction } from "../components/dashboard/resubscribe-action";
import { forwardingTag, readLastForward } from "../lib/forwarding";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";

/**
 * Webhooks — both legs of the plumbing, on one page.
 *
 * Meta → Eccos is the callback URL and its subscription ("From Meta", below);
 * Eccos → you is the forwarding target. A developer who says "webhooks" means
 * whichever of the two is currently broken, so the page shows both, in that
 * order of ownership: the half they configure first, then the half Meta owns,
 * then the contract their receiver has to satisfy.
 *
 * `requires: "waba"` and only a WABA. `getSubscriberConfig` is `scope: "any"`,
 * and a forwarding target is what an operator prepares BEFORE any traffic — so
 * this page works on a WABA that is connected and still waiting on its phone
 * number, and it never renders with no WABA at all (the root loader bounces
 * that case to /numbers). It therefore needs no "no number yet" note.
 */
export const Route = createFileRoute("/webhooks")({
  loaderDeps: ({ search }) => ({ wabaId: search.wabaId }),
  loader: ({ deps }) => getSubscriberConfig({ data: { wabaId: deps.wabaId } }),
  component: WebhooksPage,
});

function WebhooksPage() {
  const result = Route.useLoaderData();
  const { wabaId } = Route.useSearch();
  const root = useLoaderData({ from: "__root__" });
  const router = useRouter();

  const ready = root.ok && root.data.stage === "ready" ? root.data : null;
  const pending =
    root.ok && root.data.stage === "account-ready" ? root.data.resources : null;
  const selectedWabaId =
    wabaId ?? ready?.scope.selectedWabaId ?? pending?.wabas[0]?.wabaId;
  const wabas = ready?.scope.resources.wabas ?? pending?.wabas ?? [];
  const callbackUrl =
    wabas.find((waba) => waba.wabaId === selectedWabaId)?.callbackUrl ?? null;

  if (!result.ok) {
    return (
      <Page title="Webhooks" kicker="Integration">
        <FailureView failure={result} />
      </Page>
    );
  }

  const config = result.data;
  return (
    <Page
      title="Webhooks"
      kicker="Integration"
      // Data-derived, and never a control: the tag says whether a target is
      // configured, which is the one thing the page is about.
      actions={<StatusTag status={forwardingTag(config)} />}
    >
      <ForwardingFacts
        config={config}
        counts={ready?.status.counts ?? null}
        selectedWabaId={selectedWabaId}
      />

      <div className="mt-6 flex flex-col gap-6">
        <div className="flex max-w-xl flex-col gap-2">
          <ForwardingTargetPanel
            config={config}
            wabaId={selectedWabaId}
            // The route owns the data, so re-reading it after a write is the
            // route's job — which is also what keeps the panel router-free.
            onSaved={() => void router.invalidate()}
          />
          {/* The model, stated plainly and in the functional register. It is
              the question every operator asks next ("per number, or per
              account?") and the answer is a property of the gateway: one
              Durable Object per WABA, one target inside it. */}
          <p className="m-0 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            One target per WhatsApp Business account · Every number on it
            forwards here
          </p>
        </div>

        {/* Active WABA only: for one still awaiting a phone number the webhooks
            ARE subscribed, and the handshake needs a primary phone, so the
            action would mean nothing. */}
        {ready ? (
          <FromMetaPanel
            callbackUrl={callbackUrl}
            connectedAt={ready.status.connection.connectedAt}
            wabaId={selectedWabaId}
          />
        ) : null}

        <ReceiverReference />
      </div>
    </Page>
  );
}

/**
 * The strip that opens the page: is my receiver getting events, how has the
 * queue behaved, and is what it sends signed.
 *
 * Exported pieces are pure (`lib/forwarding.ts`); this section is not rendered
 * in tests because every figure in it is a router `Link` — which is also the
 * point of it (data rule 2: every metric is a door into the log that proves
 * it).
 */
function ForwardingFacts({
  config,
  counts,
  selectedWabaId,
}: {
  config: SubscriberConfig;
  /** Null while the WABA has no data plane yet — no counts exist to show. */
  counts: OperatorCounts | null;
  selectedWabaId?: string;
}) {
  const last = readLastForward(config.lastForward);
  const search = selectedWabaId ? { wabaId: selectedWabaId } : undefined;
  const deliveries = counts ? countTotal(counts.deliveries) : 0;
  return (
    <FactsStrip label="Forwarding at a glance">
      <FactCell
        kicker="Last forward"
        scale="word"
        caption={last ? "newest delivery row" : "nothing forwarded yet"}
        value={
          last ? (
            <Link
              to="/deliveries"
              search={{ status: last.status, ...search }}
              className={COUNT_LINK}
            >
              {last.status}
            </Link>
          ) : (
            "—"
          )
        }
      >
        {last ? (
          <div className="mt-3 flex flex-col gap-1">
            {/* Exact, never relative, and the full ISO on `title`: an operator
                comparing this against a log line needs the same string twice.
                `queued` and `finished` are DIFFERENT MOMENTS and the reading
                says which one this is — a row that has not finished has no
                completion time, and borrowing its arrival time would state
                something the gateway never recorded. */}
            <p className="m-0 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              {last.moment}{" "}
              <time dateTime={fmtTs(last.at)} title={fmtTs(last.at)}>
                {fmtTsShort(last.at)}
              </time>
              {" · "}
              <span className="tabular-nums">{last.attempts}</span>{" "}
              {last.attempts === 1 ? "attempt" : "attempts"}
            </p>
            {last.lastError ? (
              <p className="m-0 text-xs break-words text-[#ff7777]">{last.lastError}</p>
            ) : null}
          </div>
        ) : null}
      </FactCell>

      <FactCell
        kicker="Attempts"
        caption="forward attempts"
        value={
          counts ? (
            <Link
              to="/deliveries"
              search={search}
              aria-label={`${deliveries} delivery forward attempts`}
              className={COUNT_LINK}
            >
              {deliveries}
            </Link>
          ) : (
            "—"
          )
        }
      >
        {counts ? (
          <StatusCounts
            label="deliveries"
            counts={counts.deliveries}
            target="deliveries"
            wabaId={selectedWabaId}
          />
        ) : (
          <p className="mt-3 text-muted-foreground text-sm">
            No deliveries until the number is live.
          </p>
        )}
      </FactCell>

      <FactCell
        kicker="Signing"
        scale="word"
        value={config.hasSecret ? "secret set" : "no secret"}
        caption={
          config.hasSecret
            ? "every delivery is signed"
            : "deliveries go out unsigned"
        }
      />
    </FactsStrip>
  );
}

/**
 * The other leg: what Meta sends Eccos, and the handshake behind it.
 *
 * Exported so its markup can be asserted (`tests/webhooks-screen.test.tsx`) —
 * the page itself cannot be rendered without a router.
 */
export function FromMetaPanel({
  callbackUrl,
  connectedAt,
  wabaId,
}: {
  callbackUrl: string | null;
  /** ISO string from the gateway's connection record, or null. */
  connectedAt: string | null;
  wabaId?: string;
}) {
  return (
    <Frame variant="default" spacing="lg" className="max-w-xl">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            From Meta
          </FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            Where Meta delivers this account&apos;s events. Eccos verifies every
            callback against the app secret before it is queued.
          </FrameDescription>
        </FrameHeader>
        <dl className="my-0 -mx-(--frame-panel-px) mt-5 divide-y divide-(--line) border-y border-(--line)">
          <ReferenceRow label="Callback URL" value={callbackUrl} mono />
          <ReferenceRow label="Connected at" value={connectedAt} mono />
        </dl>
        <div className="mt-5">
          <ResubscribeAction wabaId={wabaId} />
        </div>
      </FramePanel>
    </Frame>
  );
}

/**
 * What a receiver has to implement, read out of the gateway's own forwarder
 * (`apps/gateway/src/gateway.ts`) rather than from documentation about it.
 *
 * Always rendered and deliberately quiet: it is reference, not state. It is the
 * page's last block because an operator needs it once, when they are writing
 * the endpoint — and never again after that.
 *
 * Every line below is a fact about the code as it stands:
 *  - the body is `JSON.stringify({ events })` from `ingest()`;
 *  - the signature header is only set when a secret is stored, and
 *    `signPayload` (packages/core/src/signature.ts) prefixes `sha256=`;
 *  - `x-webhook-event` is the FIRST event's type, falling back to the literal
 *    `events` when the batch cannot be parsed;
 *  - `x-idempotency-key` is `sha256Hex` of the same raw body;
 *  - `FORWARD_MAX_ATTEMPTS` is 6 (wrangler.jsonc, and the code's own default),
 *    `backoffMs` is `min(5s · 5^(n-1), 1h)` and `withJitter` spreads it ±10%;
 *  - `FORWARD_FETCH_TIMEOUT_MS` is 5s and the fetch is `redirect: "error"`.
 * If any of them changes there, it changes here.
 */
export function ReceiverReference() {
  return (
    <Frame variant="default" spacing="lg" className="max-w-xl">
      <FramePanel fit>
        <FrameHeader className="gap-1.5 pt-0">
          <FrameTitle className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Receiver reference
          </FrameTitle>
          <FrameDescription className="max-w-prose text-pretty">
            What Eccos sends, and what it does when your endpoint does not answer.
          </FrameDescription>
        </FrameHeader>
        <dl className="my-0 -mx-(--frame-panel-px) mt-5 divide-y divide-(--line) border-y border-(--line)">
          <ReferenceRow label="Request" value="POST · content-type: application/json" mono />
          <ReferenceRow label="Body" value={'{ "events": [ … ] }'} mono />
          <ReferenceRow
            label="x-eccos-signature"
            value="sha256=<HMAC-SHA256 hex of the raw body>"
            mono
            note="Sent only while a signing secret is set."
          />
          <ReferenceRow
            label="x-webhook-event"
            value="the first event's type"
            note="A batch can carry several; the header names the first."
          />
          <ReferenceRow label="x-idempotency-key" value="SHA-256 hex of the raw body" mono />
          <ReferenceRow
            label="Accepted"
            value="any 2xx"
            note="Anything else is retried, and so is a timeout."
          />
          <ReferenceRow
            label="Retries"
            value="6 attempts · 5s to 1h, ×5 each time, ±10% jitter"
          />
          <ReferenceRow label="Timeout" value="5s per attempt" />
          <ReferenceRow
            label="Redirects"
            value="refused"
            note="A 3xx fails the attempt; point the target at the final URL."
          />
        </dl>
      </FramePanel>
    </Frame>
  );
}

/** One `dt`/`dd` pair in the Workspace-panel anatomy: machine-voice label left,
 * value right, hairline between rows. */
function ReferenceRow({
  label,
  value,
  mono,
  note,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-(--frame-panel-px) py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="m-0 sm:text-right">
        <span className={cn("break-all text-foreground", mono ? "font-mono text-xs" : "text-sm")}>
          {value ?? "—"}
        </span>
        {note ? <span className="mt-0.5 block text-xs text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}
