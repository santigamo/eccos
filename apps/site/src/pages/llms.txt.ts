import type { APIRoute } from "astro";
import { COPY, DATA_TERMS, PAGES, PRICING, SITE } from "../data/product";

/**
 * /llms.txt — the plain-text brief for answer engines and for the agent someone
 * points at this page mid-conversation.
 *
 * It is generated, not written, so it cannot drift from the landing: every fact
 * comes from src/data/product.ts, which is also what the FAQ band and the
 * JSON-LD read. English, because that is the language of the queries this
 * project is found by and of the repository it links to; the Spanish landing is
 * listed in "Main pages".
 */

const en = COPY.en;

function tariff(): string {
  return PRICING.tiers
    .map((tier) => {
      if ("per" in tier) return `- Numbers ${tier.numbers}: +${tier.monthly} € per number, per month`;
      if ("plusPerNumber" in tier)
        return `- Numbers ${tier.numbers}: ${tier.monthly} €/month plus ${tier.plusPerNumber} € per number above 50`;
      if ("flat" in tier) return `- Numbers ${tier.numbers}: ${tier.monthly} €/month flat`;
      return `- Number ${tier.numbers}: ${tier.monthly} €/month`;
    })
    .join("\n");
}

const body = `# Eccos

> ${en.definition}

## What it is

${en.features.map((f) => `- ${f}`).join("\n")}
- Source: ${SITE.repo} (${SITE.license} licence)
- Provider: ${SITE.provider}, ${SITE.location} — ${SITE.email}

## What Eccos is not

${en.isNot.map((n) => `- ${n}`).join("\n")}

## Pricing (Eccos Cloud)

One metric: the connected number. Messages are unlimited on every plan and are
never metered or marked up by Eccos — Meta charges each business directly for
its own conversations, with that business's own payment method.

${tariff()}
- Messages: unlimited, on every plan

Eccos Cloud is in early access: anyone can create an account today, free and
without a card, and nothing is billed while early access lasts. Self-hosting is
free under the ${SITE.license} licence.

## Data handling (Eccos Cloud)

- Message content is kept ${DATA_TERMS.contentRetentionDays} days by default, configurable between ${DATA_TERMS.contentRetentionMinDays} and ${DATA_TERMS.contentRetentionMaxDays} days
- Storage is pinned to ${DATA_TERMS.jurisdiction}
- Never cross-referenced between businesses, never sold or shared with data brokers, never used for advertising or to train models
- Per-number erasure is available through the API
- Self-hosted, none of this data reaches us

## Main pages

${PAGES.map((p) => `- [${p.title}](${p.url}) — ${p.answers}`).join("\n")}

## FAQ

${en.faq.map((item) => `### ${item.q}\n\n${item.a}`).join("\n\n")}
`;

export const GET: APIRoute = () =>
  new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
