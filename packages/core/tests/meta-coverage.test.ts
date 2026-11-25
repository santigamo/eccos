import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetaWebhook } from "@eccos/core/parser";

// Every leaf Meta documents for the messages webhook must reach WhatsAppCallbackEvent, or be listed below.
// A leaf is forwarded when changing it changes the events and its value appears in them. It is consumed when
// changing it changes the events but its value does not appear (CONSUMED). Anything else must be in IGNORED_META_FIELDS.

type Severity = "high" | "medium" | "low";

interface Ignored {
  severity: Severity;
  reason: string;
  /** The fixtures where the leaf is dropped; in every other fixture the same path must be forwarded. */
  only?: string[];
}

const CONSUMED: Record<string, string> = {
  "messages[].edit.message.type": "Selects the edited content (media, text, location) merged into the edit event.",
  "statuses[].status": "Becomes the event type; played maps to read.",
};

const VALUE_ERRORS = "value.errors (system, app and account-level errors) are not parsed at all.";
const MEDIA_URL = "The media id is forwarded; the URL needs the access token anyway.";
const PRODUCT = "Only the product title survives (interactive.body).";
const PRICING = "Per-message cost and category are invisible to subscribers and the console.";
const FIRST_ERROR = "Only the first error's code and one message string survive.";
const PARENT_BSUID = "Parent BSUIDs are opt-in and not enabled.";
const IDENTITY_CHECK = "The identity change check is opt-in and not enabled.";

const IGNORED_META_FIELDS: Record<string, Ignored> = {
  "metadata.display_phone_number": { severity: "low", reason: "phoneNumberId is forwarded." },
  "metadata.phone_number_id": { severity: "low", reason: "value.errors yields no event to annotate.", only: ["errors.json"] },
  "errors[].code": { severity: "medium", reason: VALUE_ERRORS },
  "errors[].title": { severity: "medium", reason: VALUE_ERRORS },
  "errors[].message": { severity: "medium", reason: VALUE_ERRORS },
  "errors[].error_data.details": { severity: "medium", reason: VALUE_ERRORS },
  "errors[].href": { severity: "medium", reason: VALUE_ERRORS },

  "contacts[].profile.name": {
    severity: "low",
    reason: "Status events carry no profile name.",
    only: ["status-delivered.json", "status-played.json", "status-read.json", "status-sent.json"],
  },
  "contacts[].wa_id": { severity: "low", reason: "profileName join key, redundant with user_id; the phone reaches events as from." },
  "contacts[].user_id": { severity: "low", reason: "profileName join key, redundant with wa_id; the BSUID reaches events as fromUserId." },
  "contacts[].profile.username": { severity: "medium", reason: "Username users have no phone number; the human-readable handle is lost." },
  "contacts[].parent_user_id": { severity: "low", reason: PARENT_BSUID },
  "contacts[].identity_key_hash": { severity: "low", reason: IDENTITY_CHECK },

  "messages[].from_parent_user_id": { severity: "low", reason: PARENT_BSUID },
  "messages[].type": {
    severity: "low",
    reason: "Replies are read from their text, button or interactive body; other types forward it as messageType.",
    only: ["button.json", "group.json", "interactive-button_reply.json", "interactive-list_reply.json", "text.json"],
  },
  "messages[].interactive.type": {
    severity: "low",
    reason: "Button and list replies are read from their reply object; other kinds forward it.",
    only: ["interactive-button_reply.json", "interactive-list_reply.json"],
  },
  "messages[].group_id": { severity: "high", reason: "A group message is forwarded as if sent 1:1; latent until Eccos uses the Groups API." },
  "messages[].context.from": { severity: "low", reason: "Always the business number." },
  "messages[].context.forwarded": { severity: "low", reason: "A spam and abuse signal, not in the contract." },
  "messages[].context.frequently_forwarded": { severity: "low", reason: "A spam and abuse signal, not in the contract." },
  "messages[].context.referred_product.catalog_id": { severity: "medium", reason: "Which product a Message business tap asked about is lost." },
  "messages[].context.referred_product.product_retailer_id": {
    severity: "medium",
    reason: "Which product a Message business tap asked about is lost.",
  },
  "messages[].image.url": { severity: "low", reason: MEDIA_URL },
  "messages[].audio.url": { severity: "low", reason: MEDIA_URL },
  "messages[].video.url": { severity: "low", reason: MEDIA_URL },
  "messages[].document.url": { severity: "low", reason: MEDIA_URL },
  "messages[].sticker.url": { severity: "low", reason: MEDIA_URL },
  "messages[].edit.message.image.url": { severity: "low", reason: MEDIA_URL },
  "messages[].edit.message.context.id": { severity: "low", reason: "The edit names its target in originalMessageId." },
  "messages[].audio.voice": { severity: "medium", reason: "A voice note cannot be told apart from an audio file." },
  "messages[].sticker.animated": { severity: "low", reason: "Cosmetic." },
  "messages[].interactive.list_reply.description": { severity: "low", reason: "The row title and id are forwarded." },
  "messages[].interactive.nfm_reply.name": { severity: "low", reason: "Always flow." },
  "messages[].interactive.product.retailer_id": { severity: "medium", reason: PRODUCT },
  "messages[].interactive.product.description": { severity: "medium", reason: PRODUCT },
  "messages[].interactive.product.currency_code": { severity: "medium", reason: PRODUCT },
  "messages[].interactive.product.price_amount": { severity: "medium", reason: PRODUCT },
  "messages[].interactive.product.sale_price_amount": { severity: "medium", reason: PRODUCT },
  "messages[].interactive.product.url": { severity: "medium", reason: PRODUCT },
  "messages[].unsupported.type": { severity: "low", reason: "Which unsupported kind (poll, gif, ...) the user sent is lost." },
  "messages[].errors[].title": { severity: "low", reason: FIRST_ERROR },
  "messages[].errors[].message": { severity: "low", reason: FIRST_ERROR },

  "statuses[].recipient_id": { severity: "low", reason: "Subscribers correlate by transportMessageId." },
  "statuses[].recipient_user_id": { severity: "low", reason: "Subscribers correlate by transportMessageId." },
  "statuses[].recipient_parent_user_id": { severity: "low", reason: PARENT_BSUID },
  "statuses[].recipient_type": { severity: "low", reason: "Group recipients are indistinguishable from 1:1 ones." },
  "statuses[].recipient_participant_id": { severity: "low", reason: "Group recipients are indistinguishable from 1:1 ones." },
  "statuses[].recipient_identity_key_hash": { severity: "low", reason: IDENTITY_CHECK },
  "statuses[].biz_opaque_callback_data": { severity: "low", reason: "Eccos's send path does not set it." },
  "statuses[].conversation.id": { severity: "low", reason: "Superseded by pricing; omitted on v24+ outside free entry points." },
  "statuses[].conversation.expiration_timestamp": { severity: "medium", reason: "The free entry point window after a click-to-WhatsApp ad is invisible." },
  "statuses[].conversation.origin.type": { severity: "low", reason: "Superseded by pricing.category." },
  "statuses[].pricing.billable": { severity: "medium", reason: PRICING },
  "statuses[].pricing.pricing_model": { severity: "medium", reason: PRICING },
  "statuses[].pricing.type": { severity: "medium", reason: PRICING },
  "statuses[].pricing.category": { severity: "medium", reason: PRICING },
  "statuses[].pricing.subtype": { severity: "medium", reason: PRICING },
  "statuses[].errors[].title": { severity: "low", reason: FIRST_ERROR },
  "statuses[].errors[].message": { severity: "low", reason: FIRST_ERROR },
  "statuses[].errors[].href": { severity: "low", reason: FIRST_ERROR },
};

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "meta");
const VALUE_KEYS = ["messages", "statuses", "contacts", "errors", "metadata"];

type Path = (string | number)[];

interface Fixture {
  name: string;
  payload: { entry: { changes: { value: Record<string, unknown> }[] }[] };
}

function leaves(node: unknown, path: Path = []): { path: Path; value: unknown }[] {
  if (node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap((item, index) => leaves(item, [...path, index]));
  if (node !== null && typeof node === "object") return Object.entries(node).flatMap(([key, value]) => leaves(value, [...path, key]));
  return [{ path, value: node }];
}

/** "messages[].referral.ctwa_clid": object keys joined by dots, array indices collapsed to []. */
function normalize(path: Path): string {
  return path.reduce<string>((out, part) => (typeof part === "number" ? `${out}[]` : out ? `${out}.${part}` : part), "");
}

/** A different value of the same type, so the message still parses. */
function mutate(value: unknown): unknown {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  if (typeof value === "string" && /^\d+$/.test(value)) return String(Number(value) + 1);
  return `${value}-mutated`;
}

function withLeaf(payload: unknown, path: Path, value: unknown): unknown {
  const copy = structuredClone(payload);
  let node = copy as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) node = node[part] as Record<string | number, unknown>;
  node[path[path.length - 1] as string | number] = value;
  return copy;
}

const fixtures: Fixture[] = readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({ name: file, payload: JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")).payload }));

const usedIgnored = new Set<string>();
const usedConsumed = new Set<string>();

function uncovered(fixture: Fixture): string[] {
  const failures: string[] = [];
  const events = JSON.stringify(parseMetaWebhook(fixture.payload));
  const eventValues = new Set(leaves(JSON.parse(events)).map((leaf) => String(leaf.value)));

  fixture.payload.entry.forEach((entry, e) => {
    entry.changes.forEach((change, c) => {
      for (const leaf of VALUE_KEYS.flatMap((key) => leaves(change.value[key], [key]))) {
        const path = normalize(leaf.path);
        const mutated = withLeaf(fixture.payload, ["entry", e, "changes", c, "value", ...leaf.path], mutate(leaf.value));
        const changes = JSON.stringify(parseMetaWebhook(mutated)) !== events;
        const appears =
          eventValues.has(String(leaf.value)) || (path.endsWith(".timestamp") && eventValues.has(String(Number(leaf.value) * 1000)));
        if (changes && appears) continue;
        if (changes && CONSUMED[path]) {
          usedConsumed.add(path);
          continue;
        }
        const ignored = IGNORED_META_FIELDS[path];
        if (ignored && (!ignored.only || ignored.only.includes(fixture.name))) {
          usedIgnored.add(path);
          continue;
        }
        const why = changes
          ? "changes the events but its value never appears in them"
          : appears
            ? "only matches an event value by coincidence (changing it changes nothing)"
            : "never reaches WhatsAppCallbackEvent";
        failures.push(
          `${fixture.name}: ${path} ${why}. Forward it in packages/core/src/parser.ts, or add it to IGNORED_META_FIELDS (or CONSUMED, if it is used without being forwarded) in packages/core/tests/meta-coverage.test.ts with a reason.`,
        );
      }
    });
  });
  return failures;
}

describe("Meta payload coverage", () => {
  it("has a fixture for every Meta reference page, each naming its source", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(26);
    for (const file of readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".json"))) {
      const { source, updated } = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
      expect(source, file).toStartWith("https://developers.facebook.com/");
      expect(updated, file).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  for (const fixture of fixtures) {
    it(`forwards or explicitly ignores every documented leaf of ${fixture.name}`, () => {
      expect(uncovered(fixture)).toEqual([]);
    });
  }

  it("keeps IGNORED_META_FIELDS and CONSUMED free of stale entries", () => {
    for (const fixture of fixtures) uncovered(fixture);
    const stale = [
      ...Object.keys(IGNORED_META_FIELDS)
        .filter((path) => !usedIgnored.has(path))
        .map((path) => `IGNORED_META_FIELDS["${path}"] matches no dropped leaf in any fixture: the parser forwards it now, or no fixture has it. Remove it.`),
      ...Object.keys(CONSUMED)
        .filter((path) => !usedConsumed.has(path))
        .map((path) => `CONSUMED["${path}"] matches no consumed leaf in any fixture. Remove it.`),
    ];
    expect(stale).toEqual([]);
  });
});
