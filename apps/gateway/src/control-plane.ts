import { DurableObject } from "cloudflare:workers";
import type {
  ProvisioningStatus,
} from "@eccos/gateway-contract";
import {
  SEALED_TOKEN_PREFIX,
  openToken,
  requireTokenEncryptionKey,
  sealToken,
  wabaTokenAad,
} from "./token-crypto";

/**
 * Control plane of the account-scoped gateway.
 *
 * Message data stays in the per-WABA `EccosGateway` Durable Objects; account
 * ownership, API keys, WABA registration and the Embedded Signup connect flow
 * live here, in one Durable Object. RPC-only — never exposed as public HTTP.
 *
 * Secrets policy: only SHA-256 hashes of API keys are stored; a raw key exists
 * exactly once, in the `createAccount`/`issueApiKey` return value. Meta access
 * tokens must be presented to the Meta Graph API from the control plane, so
 * they cannot be hashed — they are encrypted instead (`src/token-crypto.ts`,
 * AES-256-GCM under a key derived from the `ECCOS_TOKEN_ENCRYPTION_KEY` Worker
 * secret) and `wabas.meta_access_token` only ever holds the `ecs1.` envelope.
 * Sealing happens in exactly one place (`prepareWabas`) and opening in exactly
 * one place (`decryptStoredToken`); no other code path may touch the column.
 */
export const API_KEY_PREFIX = "ek_";
export const API_KEY_RAW_BYTES = 32;
/** Meta WABA / phone-number ids are numeric; the existing gateway routing
 * (`gatewayObjectName`) already accepts `[A-Za-z0-9_-]+`, so keep that same
 * alphabet here. */
export const WABA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const STATE_MAX_LENGTH = 512;
/** Bound on the stored OAuth redirect_uri / console return URL. */
export const URL_MAX_LENGTH = 1024;
const PHONE_NUMBER_ID_PATTERN = /^[A-Za-z0-9_:-]+$/;
const MAX_NAME_LENGTH = 200;
const PROVISIONING_MAX_ATTEMPTS = 6;
const PROVISIONING_LEASE_MS = 60_000;
/** Exported for tests: a claim that survives `completeWabaProvisioning` is a
 * no-op unless the row still matches the claim's revision and attempt. */
export const PROVISIONING_MAX_ATTEMPTS_AT_RUNTIME = PROVISIONING_MAX_ATTEMPTS;
export const PROVISIONING_LEASE_MS_AT_RUNTIME = PROVISIONING_LEASE_MS;
const PROVISIONING_BATCH = 20;
const PROVISIONING_RETRY_BASE_MS = 5_000;
const PROVISIONING_RETRY_MAX_MS = 3_600_000;
const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ORGANIZATION_ID_MAX_LENGTH = 128;

/** Public shape of an account; never carries credentials. */
export interface AccountRecord {
  accountId: string;
  name: string;
  createdAt: number;
}

/** Stored API-key row. `hash` is SHA-256 of the raw key — never the key itself. */
export interface AccountAuth {
  keyId: string;
  accountId: string;
  label: string | null;
  hash: string;
  createdAt: number;
  revokedAt: number | null;
}

/** One registered phone number under a WABA. */
export interface PhoneRecord {
  phoneNumberId: string;
  displayPhoneNumber: string;
}

/** Owned WABA registration: account_id + credentials + phones. */
export interface AccountWaba {
  accountId: string;
  wabaId: string;
  metaAccessToken: string;
  callbackUrl: string | null;
  createdAt: number;
  provisionedAt: number | null;
  status: ProvisioningStatus;
  provisioningError: string | null;
  phones: PhoneRecord[];
}

/** Ownership metadata of a WABA — every credential is excluded. */
export interface WabaAccess {
  accountId: string;
  wabaId: string;
  callbackUrl: string | null;
  createdAt: number;
  provisionedAt: number | null;
  status: ProvisioningStatus;
  provisioningError: string | null;
  phones: PhoneRecord[];
}

export interface CreateAccountResult {
  account: AccountRecord;
  apiKey: string;
  keyId: string;
}

export interface IssueApiKeyResult {
  keyId: string;
  apiKey: string;
}

export interface RegisterWabaInput {
  accountId: string;
  wabaId: string;
  metaAccessToken: string;
  callbackUrl?: string;
  provisioningStatus?: ProvisioningStatus;
  phones: Array<{ phoneNumberId: string; displayPhoneNumber?: string }>;
}

export interface RegisterWabaResult {
  waba: AccountWaba;
  phones: PhoneRecord[];
}

export type ProvisioningFailureKind = "meta" | "gateway" | "configuration" | "unknown";

export interface ProvisioningFailure {
  kind: ProvisioningFailureKind;
  status?: number;
  retryable: boolean;
}

export interface WabaProvisioningClaim {
  accountId: string;
  wabaId: string;
  metaAccessToken: string;
  callbackUrl: string | null;
  phones: PhoneRecord[];
  revision: number;
  attempt: number;
}

interface PreparedWaba {
  accountId: string;
  wabaId: string;
  /** `ecs1.` envelope — the plaintext token is never carried past `prepareWabas`. */
  sealedToken: string;
  /** SHA-256 of the *plaintext* token: the provisioning fingerprint must stay
   * stable across re-registrations, and every envelope has a fresh random IV. */
  tokenHash: string;
  callbackUrl: string | null;
  status: ProvisioningStatus;
  phones: PhoneRecord[];
  createdAt: number;
}

interface ProvisioningRow {
  account_id: string;
  waba_id: string;
  provisioning_revision: number;
}

export interface ConnectStateRecord {
  accountId: string;
  redirectUri: string | null;
  /** Console URL the gateway sends the operator back to once Meta's callback is
   * handled. Only set by the dashboard over the RPC service binding, never by a
   * public HTTP caller — see `startConnectForAccount`. */
  returnTo: string | null;
}

export interface ApiKeySummary {
  keyId: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface AccountResources {
  account: AccountRecord | null;
  keys: ApiKeySummary[];
  wabas: WabaAccess[];
  phones: Array<PhoneRecord & { wabaId: string }>;
}

function validateWabaId(wabaId: string, field: string): string {
  const v = wabaId.trim();
  if (!WABA_ID_PATTERN.test(v)) {
    throw new Error(`invalid ${field}: expected letters, digits, "_" or "-"`);
  }
  return v;
}

function validateAccountId(accountId: string): string {
  const v = accountId.trim();
  if (!ACCOUNT_ID_PATTERN.test(v)) {
    throw new Error('invalid accountId: expected letters, digits, "_" or "-"');
  }
  return v;
}

function validateOrganizationId(organizationId: string): string {
  const v = organizationId?.trim() ?? "";
  if (!v || v.length > ORGANIZATION_ID_MAX_LENGTH || !ORGANIZATION_ID_PATTERN.test(v)) {
    throw new Error(
      `invalid organizationId: expected 1-${ORGANIZATION_ID_MAX_LENGTH} letters, digits, "_" or "-"`,
    );
  }
  return v;
}

function validateLabel(
  label: string | null | undefined,
  field: string,
): string | null {
  if (label === undefined || label === null || label.trim() === "") return null;
  const v = label.trim();
  if (v.length > MAX_NAME_LENGTH) {
    throw new Error(`invalid ${field}: at most ${MAX_NAME_LENGTH} characters`);
  }
  return v;
}

/** Keeps the connect state out of URLs and headers (state is attacker-visible
 * in the OAuth round trip), and bounds the primary-key column. */
function validateState(state: string | null): string {
  const v = state?.trim() ?? "";
  if (!v || v.length > STATE_MAX_LENGTH) {
    throw new Error(`invalid state: expected 1-${STATE_MAX_LENGTH} characters`);
  }
  return v;
}

function validateCallbackUrl(callbackUrl: string | undefined): string | null {
  if (
    callbackUrl === undefined ||
    callbackUrl === null ||
    callbackUrl.trim() === ""
  )
    return null;
  const v = callbackUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error("invalid callbackUrl: must be a valid URL");
  }
  if (parsed.protocol !== "https:")
    throw new Error("invalid callbackUrl: must use https");
  if (parsed.username || parsed.password) throw new Error("invalid callbackUrl: credentials are not allowed");
  if (parsed.hash) throw new Error("invalid callbackUrl: fragments are not allowed");
  return v;
}

/** Absolute http(s) URL, https-only off localhost, no embedded credentials.
 * Shared by the OAuth redirect_uri and the console return URL. */
function validateAbsoluteUrl(input: string | undefined, field: string): string | null {
  if (input === undefined || input.trim() === "") return null;
  const value = input.trim();
  if (value.length > URL_MAX_LENGTH) {
    throw new Error(`invalid ${field}: expected at most ${URL_MAX_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid ${field}: must be a valid URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error(`invalid ${field}: must use https`);
  }
  if (parsed.username || parsed.password) throw new Error(`invalid ${field}: credentials are not allowed`);
  return value;
}

function validateRedirectUri(redirectUri: string | undefined): string | null {
  return validateAbsoluteUrl(redirectUri, "redirectUri");
}

function validateReturnTo(returnTo: string | undefined): string | null {
  return validateAbsoluteUrl(returnTo, "returnTo");
}

/** Row -> record, so every read path returns the same shape. */
function connectStateRecord(row: Record<string, unknown>): ConnectStateRecord {
  return {
    accountId: row.account_id as string,
    redirectUri: (row.redirect_uri as string | null) ?? null,
    returnTo: (row.return_to as string | null) ?? null,
  };
}

function validateProvisioningStatus(status: ProvisioningStatus | undefined): ProvisioningStatus {
  if (status === undefined) {
    // Direct registration must be explicit about the row's status: a silent
    // default would let a caller mark a WABA active without ever provisioning
    // it. `beginWabaProvisioning*` bypasses this by forcing "pending".
    throw new Error("provisioningStatus is required for direct WABA registration");
  }
  if (status === "pending" || status === "active" || status === "failed") return status;
  throw new Error("invalid provisioningStatus");
}

function provisioningErrorMessage(failure: ProvisioningFailure): string {
  if (failure.kind === "meta") {
    return failure.status === undefined
      ? "subscribed_apps request failed"
      : `subscribed_apps failed with HTTP ${failure.status}`;
  }
  if (failure.kind === "gateway") return "gateway configuration sync failed";
  if (failure.kind === "configuration") return "Meta subscription configuration is invalid";
  return "WABA provisioning failed";
}

function provisioningBackoffMs(attempt: number): number {
  return Math.min(PROVISIONING_RETRY_BASE_MS * 5 ** Math.max(0, attempt - 1), PROVISIONING_RETRY_MAX_MS);
}

function withProvisioningJitter(ms: number): number {
  const spread = ms * 0.1;
  return Math.round(ms - spread + Math.random() * spread * 2);
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newApiKey(): string {
  const bytes = new Uint8Array(API_KEY_RAW_BYTES);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${API_KEY_PREFIX}${encoded}`;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function phonesOf(wabaId: string, sql: SqlStorage): PhoneRecord[] {
  return sql
    .exec(
      "SELECT phone_number_id, display_phone_number FROM phones WHERE waba_id = ? ORDER BY phone_number_id",
      wabaId,
    )
    .toArray()
    .map((p) => ({
      phoneNumberId: p.phone_number_id as string,
      displayPhoneNumber: (p.display_phone_number as string | null) ?? "",
    }));
}

function parsePhonesJson(raw: string): PhoneRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (
          p,
        ): p is { phoneNumberId: string; displayPhoneNumber: string | null } =>
          p !== null &&
          typeof p === "object" &&
          typeof (p as { phoneNumberId?: unknown }).phoneNumberId === "string",
      )
      .map((p) => ({
        phoneNumberId: p.phoneNumberId,
        displayPhoneNumber: p.displayPhoneNumber ?? "",
      }));
  } catch {
    return [];
  }
}

/** Stored on a WABA whose `meta_access_token` is not an `ecs1.` envelope. */
export const UNSEALED_TOKEN_ERROR =
  "meta access token is not encrypted; reconnect the number";

/**
 * Rows written before application-layer token encryption existed cannot be
 * opened: the plaintext is not an envelope and there is deliberately no
 * plaintext-tolerant read path (Eccos Cloud is multi-tenant by default and
 * legacy/shadow/dual-path compatibility is forbidden — decision 2026-08-27).
 *
 * Rather than migrating them in place, the control plane *quarantines* them on
 * every Durable Object init: the WABA is marked `failed` with an actionable
 * error, so the dashboard shows "reconnect the number" instead of failing with
 * an opaque crypto error deep inside a send. Reconnecting through Embedded
 * Signup upserts the row with a sealed envelope and clears the quarantine.
 *
 * Idempotent: a row already quarantined with this exact error is not rewritten,
 * so the returned count is 0 on every run after the first.
 */
export function quarantineUnsealedWabas(sql: SqlStorage): number {
  return sql
    .exec(
      `UPDATE wabas
          SET status = 'failed',
              provisioning_error = ?,
              provisioning_next_attempt_at = 0,
              provisioning_lease_until = NULL
        WHERE substr(meta_access_token, 1, ?) <> ?
          AND (status <> 'failed' OR provisioning_error IS NOT ?)
       RETURNING waba_id`,
      UNSEALED_TOKEN_ERROR,
      SEALED_TOKEN_PREFIX.length,
      SEALED_TOKEN_PREFIX,
      UNSEALED_TOKEN_ERROR,
    )
    .toArray().length;
}

export class EccosControlPlane extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (
        key_id     TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        label      TEXT,
        hash       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_account
        ON api_keys (account_id);`);
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash
        ON api_keys (hash);`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS wabas (
        account_id        TEXT NOT NULL,
        waba_id           TEXT PRIMARY KEY,
        meta_access_token TEXT NOT NULL,
        callback_url      TEXT,
        created_at        INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',
        provisioning_error TEXT,
        provisioning_attempts INTEGER NOT NULL DEFAULT 0,
        provisioning_next_attempt_at INTEGER NOT NULL DEFAULT 0,
        provisioning_lease_until INTEGER,
        provisioning_revision INTEGER NOT NULL DEFAULT 0,
        provisioning_fingerprint TEXT,
        provisioned_at INTEGER
      );`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_wabas_account
        ON wabas (account_id);`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS phones (
        waba_id              TEXT NOT NULL,
        phone_number_id      TEXT PRIMARY KEY,
        display_phone_number TEXT NOT NULL
      );`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_phones_waba
        ON phones (waba_id);`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS connect_states (
        state      TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        redirect_uri TEXT,
        return_to  TEXT
      );`);
      // Identity-plane link (docs/auth-tenancy-contract.md section 2): one Better
      // Auth organization <-> one Eccos account. PRIMARY KEY on organization_id +
      // UNIQUE on account_id enforce the one-to-one mapping at the storage layer;
      // the link is immutable - it is never re-pointed, only created or read.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS organization_accounts (
        organization_id TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL UNIQUE,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      INTEGER NOT NULL
      );`);
      const wabaColumns = this.sql.exec("PRAGMA table_info(wabas)").toArray();
      if (!wabaColumns.some((row) => row.name === "status")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      }
      if (!wabaColumns.some((row) => row.name === "provisioning_error")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioning_error TEXT");
      }
      if (!wabaColumns.some((row) => row.name === "provisioning_attempts")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioning_attempts INTEGER NOT NULL DEFAULT 0");
      }
      if (!wabaColumns.some((row) => row.name === "provisioning_next_attempt_at")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioning_next_attempt_at INTEGER NOT NULL DEFAULT 0");
      }
      if (!wabaColumns.some((row) => row.name === "provisioning_lease_until")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioning_lease_until INTEGER");
      }
      if (!wabaColumns.some((row) => row.name === "provisioning_revision")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioning_revision INTEGER NOT NULL DEFAULT 0");
      }
      if (!wabaColumns.some((row) => row.name === "provisioning_fingerprint")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioning_fingerprint TEXT");
      }
      if (!wabaColumns.some((row) => row.name === "provisioned_at")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioned_at INTEGER");
      }
      const stateColumns = this.sql.exec("PRAGMA table_info(connect_states)").toArray();
      if (!stateColumns.some((row) => row.name === "redirect_uri")) {
        this.sql.exec("ALTER TABLE connect_states ADD COLUMN redirect_uri TEXT");
      }
      if (!stateColumns.some((row) => row.name === "return_to")) {
        this.sql.exec("ALTER TABLE connect_states ADD COLUMN return_to TEXT");
      }
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_wabas_provisioning
        ON wabas (status, provisioning_next_attempt_at);`);
      // Fail-closed cut-over for rows predating token encryption: quarantine,
      // never migrate — there is no plaintext read path.
      quarantineUnsealedWabas(this.sql);
    });
  }

  /** The one place a stored envelope is opened. Every caller that needs the
   * plaintext token goes through here, so the crypto never spreads out into
   * the routes, the RPC entrypoint, or the provisioning loop. */
  private async decryptStoredToken(
    accountId: string,
    wabaId: string,
    stored: unknown,
  ): Promise<string> {
    if (typeof stored !== "string" || stored === "") {
      throw new Error(`WABA "${wabaId}" has no stored meta access token`);
    }
    if (!stored.startsWith(SEALED_TOKEN_PREFIX)) {
      throw new Error(`WABA "${wabaId}": ${UNSEALED_TOKEN_ERROR}`);
    }
    const secret = requireTokenEncryptionKey(this.env);
    return openToken(secret, wabaTokenAad(accountId, wabaId), stored);
  }

  async createAccount(
    input: { accountId?: string; name?: string } = {},
  ): Promise<CreateAccountResult> {
    const accountId = validateAccountId(input.accountId ?? newId("acc"));
    const name = validateLabel(input.name ?? null, "name") ?? "";
    const createdAt = Date.now();
    const apiKey = newApiKey();
    const keyId = newId("key");
    const hash = await sha256Hex(apiKey);

    // The existence check lives inside the transaction so two concurrent
    // `createAccount` calls for the same id cannot both pass the pre-check.
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec("SELECT 1 FROM accounts WHERE account_id = ?", accountId)
        .toArray();
      if (existing.length > 0)
        throw new Error(`account "${accountId}" already exists`);
      this.sql.exec(
        "INSERT INTO accounts (account_id, name, created_at) VALUES (?, ?, ?)",
        accountId,
        name,
        createdAt,
      );
      this.sql.exec(
        "INSERT INTO api_keys (key_id, account_id, label, hash, created_at, revoked_at) VALUES (?, ?, NULL, ?, ?, NULL)",
        keyId,
        accountId,
        hash,
        createdAt,
      );
    });

    return { account: { accountId, name, createdAt }, apiKey, keyId };
  }

  async issueApiKey(
    accountId: string,
    label?: string,
  ): Promise<IssueApiKeyResult> {
    const id = this.requireAccount(accountId);
    const cleanLabel = validateLabel(label ?? null, "label");
    const apiKey = newApiKey();
    const keyId = newId("key");
    const hash = await sha256Hex(apiKey);
    this.sql.exec(
      "INSERT INTO api_keys (key_id, account_id, label, hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
      keyId,
      id,
      cleanLabel,
      hash,
      Date.now(),
    );
    return { keyId, apiKey };
  }

  /** Returns true only when the key existed, was owned by `accountId`, and was
   * not already revoked. */
  revokeApiKey(accountId: string, keyId: string): boolean {
    const id = this.requireAccount(accountId);
    const revoked = this.sql
      .exec(
        "UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND account_id = ? AND revoked_at IS NULL RETURNING key_id",
        Date.now(),
        keyId,
        id,
      )
      .toArray();
    return revoked.length > 0;
  }

  /** Resolves an API key to its owner. Revoked keys fail closed (return null). */
  async authenticateApiKey(
    raw: string,
  ): Promise<{ accountId: string; keyId: string } | null> {
    if (!raw || typeof raw !== "string" || !raw.startsWith(API_KEY_PREFIX))
      return null;
    const hash = await sha256Hex(raw);
    const row = this.sql
      .exec(
        "SELECT key_id, account_id FROM api_keys WHERE hash = ? AND revoked_at IS NULL",
        hash,
      )
      .toArray()[0];
    if (!row) return null;
    return { accountId: row.account_id as string, keyId: row.key_id as string };
  }

  async registerWaba(input: RegisterWabaInput): Promise<RegisterWabaResult> {
    const result = (await this.registerWabas([input]))[0];
    if (!result) throw new Error("WABA registration failed");
    return result;
  }

  /** The one place a Meta access token is sealed. Validation is unchanged; the
   * plaintext exists only inside this function and is replaced by the `ecs1.`
   * envelope (plus a fingerprint hash) before anything is written. */
  private async prepareWabas(
    inputs: RegisterWabaInput[],
    forcedStatus?: ProvisioningStatus,
  ): Promise<PreparedWaba[]> {
    if (inputs.length === 0) return [];
    const secret = requireTokenEncryptionKey(this.env);
    const prepared = await Promise.all(inputs.map(async (input) => {
      const accountId = this.requireAccount(input.accountId);
      const wabaId = validateWabaId(input.wabaId, "wabaId");
      const metaAccessToken = input.metaAccessToken.trim();
      if (!metaAccessToken) throw new Error("invalid metaAccessToken: must not be empty");
      const callbackUrl = validateCallbackUrl(input.callbackUrl);
      const status = forcedStatus ?? validateProvisioningStatus(input.provisioningStatus);
      const phones = input.phones ?? [];
      if (phones.length === 0) throw new Error("invalid phones: at least one phone is required");
      const checkedPhones: PhoneRecord[] = [];
      const seenPhoneIds = new Set<string>();
      for (const phone of phones) {
        const phoneNumberId = phone.phoneNumberId.trim();
        if (!PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) {
          throw new Error('invalid phoneNumberId: expected letters, digits, "_", ":" or "-"');
        }
        if (seenPhoneIds.has(phoneNumberId)) throw new Error(`duplicate phoneNumberId "${phoneNumberId}"`);
        seenPhoneIds.add(phoneNumberId);
        checkedPhones.push({ phoneNumberId, displayPhoneNumber: phone.displayPhoneNumber?.trim() || "" });
      }
      const [sealedToken, tokenHash] = await Promise.all([
        sealToken(secret, wabaTokenAad(accountId, wabaId), metaAccessToken),
        sha256Hex(metaAccessToken),
      ]);
      return {
        accountId,
        wabaId,
        sealedToken,
        tokenHash,
        callbackUrl,
        status,
        phones: checkedPhones,
        createdAt: Date.now(),
      };
    }));
    const seenWabaIds = new Set<string>();
    const seenPhoneIds = new Set<string>();
    for (const item of prepared) {
      if (seenWabaIds.has(item.wabaId)) throw new Error(`duplicate wabaId "${item.wabaId}"`);
      seenWabaIds.add(item.wabaId);
      for (const phone of item.phones) {
        if (seenPhoneIds.has(phone.phoneNumberId)) throw new Error(`duplicate phoneNumberId "${phone.phoneNumberId}"`);
        seenPhoneIds.add(phone.phoneNumberId);
      }
    }
    return prepared;
  }

  private assertWabaOwnership(prepared: PreparedWaba[]): void {
    for (const item of prepared) {
      const waba = this.sql
        .exec("SELECT account_id, created_at FROM wabas WHERE waba_id = ?", item.wabaId)
        .toArray()[0];
      if (waba && waba.account_id !== item.accountId) {
        throw new Error(`waba "${item.wabaId}" is already registered to another account`);
      }
      if (waba) item.createdAt = waba.created_at as number;
      for (const phone of item.phones) {
        const owner = this.sql
          .exec(
            `SELECT p.waba_id, w.account_id FROM phones p
             JOIN wabas w ON w.waba_id = p.waba_id
             WHERE p.phone_number_id = ?`,
            phone.phoneNumberId,
          )
          .toArray()[0];
        if (!owner || (owner.waba_id === item.wabaId && owner.account_id === item.accountId)) continue;
        if (owner.account_id !== item.accountId) {
          throw new Error(`phone "${phone.phoneNumberId}" is already registered to another account`);
        }
        throw new Error(`phone "${phone.phoneNumberId}" is already registered to WABA "${owner.waba_id}"`);
      }
    }
  }

  async registerWabas(inputs: RegisterWabaInput[]): Promise<RegisterWabaResult[]> {
    const prepared = await this.prepareWabas(inputs);
    if (prepared.length === 0) return [];
    this.ctx.storage.transactionSync(() => {
      this.assertWabaOwnership(prepared);
      for (const item of prepared) {
        this.sql.exec(
          `INSERT INTO wabas
             (account_id, waba_id, meta_access_token, callback_url, created_at, status,
              provisioning_error, provisioning_attempts, provisioning_next_attempt_at,
              provisioning_lease_until, provisioning_revision, provisioning_fingerprint, provisioned_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL, 1, NULL, NULL)
           ON CONFLICT(waba_id) DO UPDATE SET
             account_id = excluded.account_id,
             meta_access_token = excluded.meta_access_token,
             callback_url = COALESCE(excluded.callback_url, wabas.callback_url),
             status = excluded.status,
             provisioning_error = NULL,
             provisioning_attempts = 0,
             provisioning_next_attempt_at = 0,
             provisioning_lease_until = NULL,
             provisioning_revision = wabas.provisioning_revision + 1,
             provisioning_fingerprint = NULL,
             provisioned_at = CASE
               WHEN excluded.status = 'active' THEN COALESCE(wabas.provisioned_at, excluded.provisioned_at)
               ELSE NULL
             END`,
          item.accountId,
          item.wabaId,
          item.sealedToken,
          item.callbackUrl,
          item.createdAt,
          item.status,
        );
        for (const phone of item.phones) {
          this.sql.exec(
            "INSERT OR REPLACE INTO phones (waba_id, phone_number_id, display_phone_number) VALUES (?, ?, ?)",
            item.wabaId,
            phone.phoneNumberId,
            phone.displayPhoneNumber,
          );
        }
      }
    });
    return Promise.all(prepared.map(async (item) => {
      const waba = await this.getWabaRecord(item.accountId, item.wabaId);
      if (!waba) throw new Error(`WABA registration failed for "${item.wabaId}"`);
      return { waba, phones: waba.phones };
    }));
  }

  async beginWabaProvisioning(input: RegisterWabaInput): Promise<RegisterWabaResult> {
    const result = (await this.beginWabaProvisioningBatch([input]))[0];
    if (!result) throw new Error("WABA provisioning failed");
    return result;
  }

  async beginWabaProvisioningBatch(inputs: RegisterWabaInput[]): Promise<RegisterWabaResult[]> {
    const prepared = await this.prepareWabas(inputs, "pending");
    if (prepared.length === 0) return [];
    if (prepared.some((item) => item.callbackUrl === null)) {
      throw new Error("callbackUrl is required for WABA provisioning");
    }
    const fingerprints = await Promise.all(
      prepared.map(async (item) =>
        sha256Hex(
          JSON.stringify({
            wabaId: item.wabaId,
            // Hash of the plaintext, not of the envelope: two registrations of
            // the same token must produce the same fingerprint (the envelope
            // carries a fresh IV every time), or provisioning stops being
            // idempotent and re-subscribes Meta on every retry.
            tokenHash: item.tokenHash,
            callbackUrl: item.callbackUrl,
            phones: [...item.phones].sort((a, b) => a.phoneNumberId.localeCompare(b.phoneNumberId)),
          }),
        ),
      ),
    );
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.assertWabaOwnership(prepared);
      for (const [index, item] of prepared.entries()) {
        const fingerprint = fingerprints[index];
        if (!fingerprint) throw new Error(`WABA provisioning fingerprint failed for "${item.wabaId}"`);
        const existing = this.sql
          .exec(
            "SELECT status, provisioning_fingerprint, provisioning_revision FROM wabas WHERE waba_id = ? AND account_id = ?",
            item.wabaId,
            item.accountId,
          )
          .toArray()[0];
        if (
          existing?.provisioning_fingerprint === fingerprint &&
          existing.status !== "failed"
        ) continue;
        const revision = Number(existing?.provisioning_revision ?? 0) + 1;
        this.sql.exec(
          `INSERT INTO wabas
             (account_id, waba_id, meta_access_token, callback_url, created_at, status,
              provisioning_error, provisioning_attempts, provisioning_next_attempt_at,
              provisioning_lease_until, provisioning_revision, provisioning_fingerprint, provisioned_at)
           VALUES (?, ?, ?, ?, ?, 'pending', NULL, 0, ?, NULL, ?, ?, NULL)
           ON CONFLICT(waba_id) DO UPDATE SET
             account_id = excluded.account_id,
             meta_access_token = excluded.meta_access_token,
             callback_url = excluded.callback_url,
             status = 'pending',
             provisioning_error = NULL,
             provisioning_attempts = 0,
             provisioning_next_attempt_at = excluded.provisioning_next_attempt_at,
             provisioning_lease_until = NULL,
             provisioning_revision = excluded.provisioning_revision,
             provisioning_fingerprint = excluded.provisioning_fingerprint,
             provisioned_at = NULL`,
          item.accountId,
          item.wabaId,
          item.sealedToken,
          item.callbackUrl,
          item.createdAt,
          now,
          revision,
          fingerprint,
        );
        const retainedPhones = new Set(item.phones.map((phone) => phone.phoneNumberId));
        for (const row of this.sql.exec("SELECT phone_number_id FROM phones WHERE waba_id = ?", item.wabaId).toArray()) {
          if (!retainedPhones.has(row.phone_number_id as string)) {
            this.sql.exec("DELETE FROM phones WHERE waba_id = ? AND phone_number_id = ?", item.wabaId, row.phone_number_id);
          }
        }
        for (const phone of item.phones) {
          this.sql.exec(
            "INSERT OR REPLACE INTO phones (waba_id, phone_number_id, display_phone_number) VALUES (?, ?, ?)",
            item.wabaId,
            phone.phoneNumberId,
            phone.displayPhoneNumber,
          );
        }
      }
    });
    return Promise.all(prepared.map(async (item) => {
      const waba = await this.getWabaRecord(item.accountId, item.wabaId);
      if (!waba) throw new Error(`WABA provisioning failed for "${item.wabaId}"`);
      return { waba, phones: waba.phones };
    }));
  }

  /** Full registration incl. credentials + phones — only for the owning account.
   * Non-active registrations resolve to `null` *before* the token is opened, so
   * a quarantined row reads as "not configured" instead of throwing here. */
  async getWaba(accountId: string, wabaId: string): Promise<AccountWaba | null> {
    const row = this.readWabaRow(accountId, wabaId);
    if (!row || ((row.status as ProvisioningStatus) ?? "active") !== "active") return null;
    return this.hydrateWaba(row);
  }

  async getWabaRecord(accountId: string, wabaId: string): Promise<AccountWaba | null> {
    const row = this.readWabaRow(accountId, wabaId);
    return row ? this.hydrateWaba(row) : null;
  }

  /** Raw owned row, credentials still sealed. */
  private readWabaRow(accountId: string, wabaId: string): Record<string, unknown> | null {
    const id = validateAccountId(accountId);
    const owned = this.sql
      .exec("SELECT account_id FROM accounts WHERE account_id = ?", id)
      .toArray()[0];
    if (!owned) return null;
    const wabaIdN = validateWabaId(wabaId, "wabaId");
    const row = this.sql
      .exec(
        "SELECT account_id, waba_id, meta_access_token, callback_url, created_at, provisioned_at, status, provisioning_error FROM wabas WHERE waba_id = ? AND account_id = ?",
        wabaIdN,
        id,
      )
      .toArray()[0];
    return row ?? null;
  }

  private async hydrateWaba(row: Record<string, unknown>): Promise<AccountWaba> {
    const accountId = row.account_id as string;
    const wabaId = row.waba_id as string;
    return {
      accountId,
      wabaId,
      metaAccessToken: await this.decryptStoredToken(accountId, wabaId, row.meta_access_token),
      callbackUrl: (row.callback_url as string | null) ?? null,
      createdAt: row.created_at as number,
      provisionedAt: (row.provisioned_at as number | null) ?? null,
      status: (row.status as ProvisioningStatus) ?? "active",
      provisioningError: (row.provisioning_error as string | null) ?? null,
      phones: phonesOf(wabaId, this.sql),
    };
  }

  /** Ownership metadata only — never the access token. */
  getWabaById(wabaId: string): WabaAccess | null {
    const wabaIdN = validateWabaId(wabaId, "wabaId");
    const row = this.sql
      .exec(
        "SELECT account_id, waba_id, callback_url, created_at, provisioned_at, status, provisioning_error FROM wabas WHERE waba_id = ?",
        wabaIdN,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      accountId: row.account_id as string,
      wabaId: row.waba_id as string,
      callbackUrl: (row.callback_url as string | null) ?? null,
      createdAt: row.created_at as number,
      provisionedAt: (row.provisioned_at as number | null) ?? null,
      status: (row.status as ProvisioningStatus) ?? "active",
      provisioningError: (row.provisioning_error as string | null) ?? null,
      phones: phonesOf(wabaIdN, this.sql),
    };
  }

  async retryWabaProvisioning(accountId: string, wabaId: string): Promise<AccountWaba | null> {
    const account = this.requireAccount(accountId);
    const id = validateWabaId(wabaId, "wabaId");
    const now = Date.now();
    this.sql.exec(
      `UPDATE wabas
       SET status = 'pending', provisioning_error = NULL, provisioning_attempts = 0,
           provisioning_next_attempt_at = ?, provisioning_lease_until = NULL,
           provisioning_revision = provisioning_revision + 1, provisioned_at = NULL
       WHERE account_id = ? AND waba_id = ? AND status IN ('pending', 'failed')
         AND substr(meta_access_token, 1, ?) = ?`,
      now,
      account,
      id,
      SEALED_TOKEN_PREFIX.length,
      SEALED_TOKEN_PREFIX,
    );
    // A quarantined WABA stays `failed`: retrying it could never succeed, and
    // `getWabaRecord` below surfaces the actionable "reconnect the number".
    return this.getWabaRecord(account, id);
  }

  async claimWabaProvisioning(accountId: string, wabaId: string): Promise<WabaProvisioningClaim | null> {
    const account = this.requireAccount(accountId);
    return this.claimProvisioning(account, validateWabaId(wabaId, "wabaId"), Date.now());
  }

  async claimPendingWabaProvisioning(limit = PROVISIONING_BATCH): Promise<WabaProvisioningClaim[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error("limit must be an integer between 1 and 100");
    }
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT account_id, waba_id, provisioning_revision
         FROM wabas
         WHERE status = 'pending'
           AND provisioning_next_attempt_at <= ?
           AND (provisioning_lease_until IS NULL OR provisioning_lease_until <= ?)
           AND substr(meta_access_token, 1, ?) = ?
         ORDER BY provisioning_next_attempt_at, waba_id
         LIMIT ?`,
        now,
        now,
        SEALED_TOKEN_PREFIX.length,
        SEALED_TOKEN_PREFIX,
        limit,
      )
      .toArray() as unknown as ProvisioningRow[];
    const claims: WabaProvisioningClaim[] = [];
    for (const row of rows) {
      const claim = await this.claimProvisioning(row.account_id, row.waba_id, now, row.provisioning_revision);
      if (claim) claims.push(claim);
    }
    return claims;
  }

  private async claimProvisioning(
    accountId: string,
    wabaId: string,
    now: number,
    revision?: number,
  ): Promise<WabaProvisioningClaim | null> {
    const leaseUntil = now + PROVISIONING_LEASE_MS;
    const revisionClause = revision === undefined ? "" : " AND provisioning_revision = ?";
    const revisionArgs = revision === undefined ? [] : [revision];
    const claimed = this.ctx.storage.transactionSync(() =>
      this.sql
        .exec(
          `UPDATE wabas
           SET provisioning_attempts = provisioning_attempts + 1,
               provisioning_next_attempt_at = ?, provisioning_lease_until = ?
           WHERE account_id = ? AND waba_id = ? AND status = 'pending'
             AND provisioning_next_attempt_at <= ?
             AND (provisioning_lease_until IS NULL OR provisioning_lease_until <= ?)
             ${revisionClause}
            RETURNING account_id, waba_id, meta_access_token, callback_url, provisioning_attempts,
                      provisioning_revision`,
          leaseUntil,
          leaseUntil,
          accountId,
          wabaId,
          now,
          now,
          ...revisionArgs,
        )
        .toArray()[0],
    );
    if (!claimed) return null;
    return {
      accountId: claimed.account_id as string,
      wabaId: claimed.waba_id as string,
      metaAccessToken: await this.decryptStoredToken(
        claimed.account_id as string,
        claimed.waba_id as string,
        claimed.meta_access_token,
      ),
      callbackUrl: (claimed.callback_url as string | null) ?? null,
      phones: phonesOf(wabaId, this.sql),
      revision: claimed.provisioning_revision as number,
      attempt: claimed.provisioning_attempts as number,
    };
  }

  async completeWabaProvisioning(input: {
    accountId: string;
    wabaId: string;
    revision: number;
    attempt: number;
    success: boolean;
    failure?: ProvisioningFailure;
  }): Promise<AccountWaba | null> {
    const account = this.requireAccount(input.accountId);
    const id = validateWabaId(input.wabaId, "wabaId");
    if (!Number.isSafeInteger(input.revision) || !Number.isSafeInteger(input.attempt)) {
      throw new Error("invalid provisioning claim");
    }
    const completedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      const current = this.sql
        .exec(
          `SELECT status, provisioning_revision, provisioning_attempts
           FROM wabas WHERE account_id = ? AND waba_id = ?`,
          account,
          id,
        )
        .toArray()[0];
      if (
        !current ||
        current.status !== "pending" ||
        current.provisioning_revision !== input.revision ||
        current.provisioning_attempts !== input.attempt
      ) return;
      if (input.success) {
        this.sql.exec(
          `UPDATE wabas
           SET status = 'active', provisioning_error = NULL, provisioning_next_attempt_at = 0,
               provisioning_lease_until = NULL, provisioned_at = ?
           WHERE account_id = ? AND waba_id = ? AND status = 'pending'
             AND provisioning_revision = ? AND provisioning_attempts = ?`,
          completedAt,
          account,
          id,
          input.revision,
          input.attempt,
        );
        return;
      }
      const failure = input.failure;
      if (!failure) throw new Error("provisioning failure details are required");
      const terminal = !failure.retryable || input.attempt >= PROVISIONING_MAX_ATTEMPTS;
      this.sql.exec(
        terminal
          ? `UPDATE wabas
             SET status = 'failed', provisioning_error = ?, provisioning_next_attempt_at = 0,
                 provisioning_lease_until = NULL
             WHERE account_id = ? AND waba_id = ? AND status = 'pending'
               AND provisioning_revision = ? AND provisioning_attempts = ?`
          : `UPDATE wabas
             SET status = 'pending', provisioning_error = ?, provisioning_next_attempt_at = ?,
                 provisioning_lease_until = NULL
             WHERE account_id = ? AND waba_id = ? AND status = 'pending'
               AND provisioning_revision = ? AND provisioning_attempts = ?`,
        provisioningErrorMessage(failure),
        ...(terminal
          ? [account, id, input.revision, input.attempt]
          : [completedAt + withProvisioningJitter(provisioningBackoffMs(input.attempt)), account, id, input.revision, input.attempt]),
      );
    });
    return this.getWabaRecord(account, id);
  }

  /** Everything an account owns, with every credential stripped (no API-key
   * hashes, no Meta tokens). */
  listAccountResources(accountId: string): AccountResources {
    const id = this.requireAccount(accountId);
    const account = this.sql
      .exec(
        "SELECT account_id, name, created_at FROM accounts WHERE account_id = ?",
        id,
      )
      .toArray()[0];
    if (!account) {
      return { account: null, keys: [], wabas: [], phones: [] };
    }
    const keys = this.sql
      .exec(
        "SELECT key_id, label, created_at, revoked_at FROM api_keys WHERE account_id = ? ORDER BY key_id",
        id,
      )
      .toArray()
      .map((row) => ({
        keyId: row.key_id as string,
        label: row.label as string | null,
        createdAt: row.created_at as number,
        revokedAt: row.revoked_at as number | null,
      }));
    const wabaRows = this.sql
      .exec(
        `SELECT w.waba_id, w.callback_url, w.created_at, w.provisioned_at, w.status, w.provisioning_error,
                COALESCE(json_group_array(
                  json_object('phoneNumberId', p.phone_number_id,
                              'displayPhoneNumber', p.display_phone_number)), '[]') AS phones
         FROM wabas w
         LEFT JOIN phones p ON p.waba_id = w.waba_id
         WHERE w.account_id = ?
         GROUP BY w.waba_id, w.callback_url, w.created_at, w.provisioned_at, w.status, w.provisioning_error
         ORDER BY w.waba_id`,
        id,
      )
      .toArray();
    const wabas: WabaAccess[] = wabaRows.map((row) => ({
      accountId: id,
      wabaId: row.waba_id as string,
      callbackUrl: (row.callback_url as string | null) ?? null,
      createdAt: row.created_at as number,
      provisionedAt: (row.provisioned_at as number | null) ?? null,
      status: (row.status as ProvisioningStatus) ?? "active",
      provisioningError: (row.provisioning_error as string | null) ?? null,
      phones: parsePhonesJson((row.phones as string | null) ?? "[]"),
    }));
    return {
      account: {
        accountId: id,
        name: account.name as string,
        createdAt: account.created_at as number,
      },
      keys,
      wabas,
      phones: wabas.flatMap((w) =>
        w.phones.map((p) => ({ ...p, wabaId: w.wabaId })),
      ),
    };
  }

  /**
   * Idempotent organization-to-account provisioning saga (contract section 2):
   * resolves the existing one-to-one link for `organizationId`, or creates the
   * Eccos account AND the active link atomically inside one DO transaction.
   * Never issues an API key and never rebinds an existing link; concurrent or
   * retried calls converge to exactly one account and one link row.
   */
  async ensureOrganizationAccount(
    organizationId: string,
    name?: string,
  ): Promise<{ accountId: string; status: "active" | "existing" }> {
    const orgId = validateOrganizationId(organizationId);
    const accountName = validateLabel(name ?? null, "name") ?? "";
    let result: { accountId: string; status: "active" | "existing" } | null = null;
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec(
          "SELECT account_id, status FROM organization_accounts WHERE organization_id = ?",
          orgId,
        )
        .toArray()[0];
      if (existing) {
        const status = existing.status as string;
        // A link exists: never rebind. Only an active link resolves to an account.
        if (status !== "active") {
          throw new Error(`organization "${orgId}" link is ${status}; access fails closed`);
        }
        result = { accountId: existing.account_id as string, status: "existing" };
        return;
      }
      const accountId = newId("acc");
      const createdAt = Date.now();
      this.sql.exec(
        "INSERT INTO accounts (account_id, name, created_at) VALUES (?, ?, ?)",
        accountId,
        accountName,
        createdAt,
      );
      this.sql.exec(
        "INSERT INTO organization_accounts (organization_id, account_id, status, created_at) VALUES (?, ?, 'active', ?)",
        orgId,
        accountId,
        createdAt,
      );
      result = { accountId, status: "active" };
    });
    if (!result) throw new Error("organization account provisioning failed");
    return result;
  }

  /** Read the one-to-one organization link. `pending`/`disabled` links are
   * returned as-is so callers fail closed; unknown organizations return null. */
  getOrganizationAccountLink(
    organizationId: string,
  ): { accountId: string; status: "active" | "pending" | "disabled" } | null {
    const orgId = validateOrganizationId(organizationId);
    const row = this.sql
      .exec(
        "SELECT account_id, status FROM organization_accounts WHERE organization_id = ?",
        orgId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      accountId: row.account_id as string,
      status: row.status as "active" | "pending" | "disabled",
    };
  }

  purgeExpiredConnectStates(now = Date.now()): void {
    if (!Number.isFinite(now)) throw new Error("invalid now: expected a finite timestamp");
    this.sql.exec("DELETE FROM connect_states WHERE expires_at <= ?", now);
  }

  refreshConnectState(state: string, expiresAt: number): ConnectStateRecord | null {
    const s = state?.trim() ?? "";
    if (!s || s.length > STATE_MAX_LENGTH) return null;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("invalid expiresAt: must be a future timestamp");
    }
    const now = Date.now();
    let result: ConnectStateRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          "SELECT account_id, expires_at, redirect_uri, return_to FROM connect_states WHERE state = ?",
          s,
        )
        .toArray()[0];
      if (!row) return;
      if ((row.expires_at as number) <= now) {
        this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
        return;
      }
      this.sql.exec("UPDATE connect_states SET expires_at = ? WHERE state = ?", expiresAt, s);
      result = connectStateRecord(row);
    });
    return result;
  }

  /** Register a connect state; INSERT OR REPLACE so a retried start wins. */
  startConnectState(
    state: string,
    accountId: string,
    expiresAt: number,
    redirectUri?: string,
    returnTo?: string,
  ): void {
    const s = validateState(state);
    const id = this.requireAccount(accountId);
    const redirect = validateRedirectUri(redirectUri);
    const back = validateReturnTo(returnTo);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("invalid expiresAt: must be a future timestamp");
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO connect_states (state, account_id, expires_at, redirect_uri, return_to) VALUES (?, ?, ?, ?, ?)",
      s,
      id,
      expiresAt,
      redirect,
      back,
    );
  }

  /** Single-use: returns the account once, then deletes the state. Expired or
   * unknown states are consumed (deleted) and return null. */
  consumeConnectState(state: string): string | null {
    return this.consumeConnectStateRecord(state)?.accountId ?? null;
  }

  consumeConnectStateForAccount(state: string, accountId: string): ConnectStateRecord | null {
    const s = state?.trim() ?? "";
    if (!s || s.length > STATE_MAX_LENGTH) return null;
    const id = validateAccountId(accountId);
    const now = Date.now();
    let result: ConnectStateRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          "SELECT account_id, expires_at, redirect_uri, return_to FROM connect_states WHERE state = ?",
          s,
        )
        .toArray()[0];
      if (!row) return;
      if ((row.expires_at as number) <= now) {
        this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
        return;
      }
      if (row.account_id !== id) return;
      result = connectStateRecord(row);
      this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
    });
    return result;
  }

  consumeConnectStateRecord(state: string): ConnectStateRecord | null {
    const s = state?.trim() ?? "";
    if (!s || s.length > STATE_MAX_LENGTH) return null;
    const now = Date.now();
    let result: ConnectStateRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          "SELECT account_id, expires_at, redirect_uri, return_to FROM connect_states WHERE state = ?",
          s,
        )
        .toArray()[0];
      if (!row) return;
      if ((row.expires_at as number) <= now) {
        this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
        return;
      }
      result = connectStateRecord(row);
      this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
    });
    return result;
  }

  getConnectStateAccount(state: string): string | null {
    return this.getConnectState(state)?.accountId ?? null;
  }

  getConnectState(state: string): ConnectStateRecord | null {
    const s = state?.trim() ?? "";
    if (!s || s.length > STATE_MAX_LENGTH) return null;
    const row = this.sql
      .exec("SELECT account_id, expires_at, redirect_uri, return_to FROM connect_states WHERE state = ?", s)
      .toArray()[0];
    if (!row) return null;
    if ((row.expires_at as number) <= Date.now()) {
      this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
      return null;
    }
    return connectStateRecord(row);
  }

  /** Cheap liveness probe for readiness checks — no credentials involved. */
  getHealth(): { ok: true; accounts: number; wabas: number } {
    const accountRow = this.sql
      .exec("SELECT COUNT(*) AS c FROM accounts")
      .toArray()[0];
    const wabaRow = this.sql
      .exec("SELECT COUNT(*) AS c FROM wabas")
      .toArray()[0];
    return {
      ok: true,
      accounts: Number(accountRow?.c ?? 0),
      wabas: Number(wabaRow?.c ?? 0),
    };
  }

  private requireAccount(accountId: string): string {
    const id = validateAccountId(accountId);
    const row = this.sql
      .exec("SELECT account_id FROM accounts WHERE account_id = ?", id)
      .toArray()[0];
    if (!row) throw new Error(`account "${id}" does not exist`);
    return id;
  }
}
