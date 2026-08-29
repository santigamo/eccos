# @eccos/auth-baseline

Product-agnostic **Better Auth organization baseline** extracted from the Eccos
customer-auth cut (eccos-0x0) so side projects can adopt the same identity-plane
conventions without coupling to Eccos's gateway or data.

## What is shared (code & process)

- **Config conventions** (`src/config.ts`): request-scoped Better Auth factory,
  fail-closed secret handling, canonical-origin allowlist, cookie posture
  (HttpOnly / SameSite=Lax / Secure-on-https), 15-minute session freshness for
  step-up, database-backed rate limiting.
- **Capability model** (`src/permissions.ts`): an access controller with a
  product `resource` (`gateway` here) and five actions — rename the resource,
  keep the shape.
- **Tenant guards** (`src/tenant.ts`): server-side session/membership/permission
  resolution that treats browser-supplied org ids as UX input only.
- **Invitation defaults**: verified-email requirement, owner/admin gating.
- **D1 workflow**: one dedicated EU-jurisdiction D1 per product per environment;
  schema generated with the Better Auth CLI and applied at deploy.

## What stays isolated (per project)

- **Data**: a separate D1 database per product/environment — never a shared
  identity database. User data, organizations, memberships, sessions, and
  cookies never leave the project.
- **Secrets**: per-project Worker secrets (`BETTER_AUTH_SECRET`, mail keys).
- **Email provider**: per-project domain, SPF/DKIM/DMARC, and DPA records.
- **Production bindings**: service bindings, WebAuthn RP IDs, and hostnames are
  project-local.
- **Product resources**: the `gateway` permission resource and any account
  mapping (Eccos's `organization_accounts` control-plane table) are adapters
  owned by the product, not the baseline.

## Extension points

1. **Resource actions** — replace `gateway` in `defineProductStatement` with
   your product's resource name; the role matrix shape carries over.
2. **Account linking** — implement a product-side idempotent
   `ensureProductAccount(organizationId)` saga (Eccos's is a Durable Object
   transaction creating no API key); the baseline never creates product
   resources.
3. **Billing** — not included by design; a future cross-product SSO runtime or
   centralized billing is a separate decision and must not be introduced here.

## Usage

```ts
import { createOrgAuthConfig, ac, roles } from "@eccos/auth-baseline";

export const auth = betterAuth(createOrgAuthConfig({
  database: env.DB,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: "https://app.yourproject.com",
  mail: yourMailSender,
}));
```

Tests in `tests/` cover session, organization, membership, permission,
invitation, and revocation behavior against an in-memory SQLite database.
