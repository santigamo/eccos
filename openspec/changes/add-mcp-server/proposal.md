# Proposal: MCP server for agent-driven onboarding and management

Change id: `add-mcp-server` · Status: proposed · Tracking issue: SAN-3 · Researched and verified: 2026-11-23

This change is a specification only. It adds no code, no dependency and no behavior.

## Problem

Everything a customer does to take a WhatsApp number from nothing to operational on Eccos Cloud
happens in the console today, by hand: sign up, create a workspace, subscribe, run Embedded
Signup, set the subscriber webhook, issue an API key, create a template, send a test. The gateway
has a machine surface (`/v1/*` with an account API key), but it starts *after* all of that, and
it covers sending, not setup.

Customers increasingly work through AI agents (Claude, ChatGPT, Cursor and their own). An agent
has no way to do this work for them: there is no MCP server, the console's operations are
TanStack server functions bound to a browser session, and `GatewayRPC` is private by design.

## Goal

A remote MCP server through which a customer's own agent manages their Eccos workspace end to
end: connect to Eccos, obtain the Embedded Signup link, follow onboarding, configure numbers,
webhook, API keys and templates, send a test, and later operate broadcasts, scheduled sends and
conversations, and obtain new numbers.

Decisions already made by the owner:

1. The audience is customers. Every tool is scoped to one account, consistent with the
   account → WABA → phone rule.
2. Authorization is OAuth from the first release, issued by the Better Auth instance that already
   runs the console.
3. The server is built on Cloudflare's current MCP stack.

## What this change proposes

- A new Worker, `apps/mcp`, that is a stateless MCP **resource server** on its own hostname. It
  holds no storage and no credential that grants access, and reaches the rest of Eccos only through
  service bindings. Its one secret, `REQUEST_STATE_KEY`, seals the approval state; a leaked key can
  forge an approval state, which still cannot run a tool because elevation is re-read from
  `authorize` on every request.
- The console's Better Auth instance becomes the OAuth 2.1 **authorization server** for it, with a
  consent screen that binds each grant to one workspace.
- A second private RPC entrypoint on the console Worker (`ConsoleRPC`) that validates a token and
  re-derives membership, role and account on **every** MCP request, so the tenancy contract's
  "re-resolved per request" rule holds for agents exactly as it does for browsers.
- A tool inventory mapped to the existing role matrix, delivered in phases that each ship on
  their own. The first phase needs one small gateway addition, the secret claim.
- Admin rights that work like `sudo`: a long-lived grant, and a 24-hour approval by the person
  that only sensitive tools need.
- New secrets delivered by a one-time claim, so an API key goes from Eccos to the customer's
  `.env` without entering a model's context.

Details: [design.md](./design.md), requirements and acceptance criteria:
[specs/mcp-server/spec.md](./specs/mcp-server/spec.md), sources and versions:
[research.md](./research.md), number purchase: [number-purchase.md](./number-purchase.md),
work breakdown: [tasks.md](./tasks.md).

## What the goal cannot be, stated plainly

The brief was that Embedded Signup is the only human step. With the decisions above, three
moments need a person, and the design keeps each to one link the agent hands over:

1. **Authorizing the agent.** OAuth exists so that a person signs in and consents. A new customer
   also verifies their email and names their workspace in that same browser visit. This happens
   once per agent and workspace, not once per task.
2. **Subscribing.** Eccos Cloud requires a subscription before a number can be added, and the
   trial asks for a card at Creem's checkout. An agent cannot enter a card.
3. **Embedded Signup**, as accepted.

Removing the second is a pricing decision, not an engineering one. The owner accepted both for
now ([design.md § Decisions](./design.md#decisions)). Sensitive actions add a fourth, lighter
moment: approving them once per 24 hours, which can be done in the same visit as the first.

"Buying a number" does not reduce to an API call either: every carrier that sells Spanish numbers
requires the holder's identity and address documents, and Eccos selling numbers itself raises an
unanswered regulatory question. [number-purchase.md](./number-purchase.md) lays out the options.

## Impact

| Area | Change |
|---|---|
| `apps/mcp` (new) | Worker with the MCP endpoint, protected-resource metadata and the tools |
| `apps/dashboard` | Better Auth OAuth provider plugins, consent, workspace-selection, approval and claim pages, authorization-server metadata routes, a "Connected agents" settings section, the `ConsoleRPC` entrypoint, a D1 migration |
| `packages/console-contract` (new) | Types for `ConsoleRPC`, as `gateway-contract` is for `GatewayRPC` |
| `apps/gateway`, `packages/gateway-contract` | Phase 1 adds secret claims (one control-plane table, two RPC methods). Phase 3 adds phone-number management against the Graph API; phase 4 adds RPC methods to create broadcasts and scheduled sends |
| `docs/auth-tenancy-contract.md`, `docs/threat-model.md` | Amended: a new credential type, a new trust boundary, new Better Auth endpoints (see design § Contract amendments) |
| `better-auth` | Exact pin moves from 1.7.14 to 1.7.27, required by the plugins and overdue for the 2026-11-03 advisories |

Not affected: the public `/v1` API and account API keys, the forwarding contract
(`WhatsAppCallbackEvent`), the Bun self-host target, and any existing console behavior.

## Out of scope

- A local (stdio) MCP server, and MCP for the Bun target.
- Operator or cross-account tooling. There is no admin tool and no tool that takes an account id.
- GDPR erasure over MCP, in any phase (owner-only and destructive; it stays a console action).
- Eccos acting as an MCP *client*.
