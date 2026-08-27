import { DurableObject } from "cloudflare:workers";
import type { ProvisioningStatus } from "@eccos/gateway-contract";

/**
 * Control plane for the multi-tenant foundation.
 *
 * Single-tenant message data stays in the per-WABA `EccosGateway` Durable
 * Objects; account ownership, API keys, WABA registration and the Embedded
 * Signup connect flow live here, in one Durable Object. RPC-only — never
 * exposed as public HTTP.
 *
 * Secrets policy: only SHA-256 hashes of API keys are stored; a raw key exists
 * exactly once, in the `createAccount`/`issueApiKey` return value. Meta access
 * tokens are stored plaintext in `wabas` because they must be presented to the
 * Meta Graph API from the control plane.
 */
export const API_KEY_PREFIX = "ek_";
export const API_KEY_RAW_BYTES = 32;
/** Meta WABA / phone-number ids are numeric; the existing gateway routing
 * (`gatewayObjectName`) already accepts `[A-Za-z0-9_-]+`, so keep that same
 * alphabet here. */
export const WABA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const STATE_MAX_LENGTH = 512;
const PHONE_NUMBER_ID_PATTERN = /^[A-Za-z0-9_:-]+$/;
const MAX_NAME_LENGTH = 200;

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

export interface ConnectStateRecord {
  accountId: string;
  redirectUri: string | null;
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
  return v;
}

function validateRedirectUri(redirectUri: string | undefined): string | null {
  if (redirectUri === undefined || redirectUri.trim() === "") return null;
  const value = redirectUri.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid redirectUri: must be a valid URL");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
    throw new Error("invalid redirectUri: must use https");
  }
  if (parsed.username || parsed.password) throw new Error("invalid redirectUri: credentials are not allowed");
  return value;
}

function validateProvisioningStatus(status: ProvisioningStatus | undefined): ProvisioningStatus {
  if (status === undefined) return "active";
  if (status === "pending" || status === "active" || status === "failed") return status;
  throw new Error("invalid provisioningStatus");
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
        provisioning_error TEXT
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
        redirect_uri TEXT
      );`);
      const wabaColumns = this.sql.exec("PRAGMA table_info(wabas)").toArray();
      if (!wabaColumns.some((row) => row.name === "status")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      }
      if (!wabaColumns.some((row) => row.name === "provisioning_error")) {
        this.sql.exec("ALTER TABLE wabas ADD COLUMN provisioning_error TEXT");
      }
      const stateColumns = this.sql.exec("PRAGMA table_info(connect_states)").toArray();
      if (!stateColumns.some((row) => row.name === "redirect_uri")) {
        this.sql.exec("ALTER TABLE connect_states ADD COLUMN redirect_uri TEXT");
      }
    });
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

  registerWaba(input: RegisterWabaInput): RegisterWabaResult {
    const result = this.registerWabas([input])[0];
    if (!result) throw new Error("WABA registration failed");
    return result;
  }

  registerWabas(inputs: RegisterWabaInput[]): RegisterWabaResult[] {
    if (inputs.length === 0) return [];

    const prepared = inputs.map((input) => {
      const accountId = this.requireAccount(input.accountId);
      const wabaId = validateWabaId(input.wabaId, "wabaId");
      const metaAccessToken = input.metaAccessToken.trim();
      if (!metaAccessToken) throw new Error("invalid metaAccessToken: must not be empty");
      const callbackUrl = validateCallbackUrl(input.callbackUrl);
      const status = validateProvisioningStatus(input.provisioningStatus);
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
      return { accountId, wabaId, metaAccessToken, callbackUrl, status, phones: checkedPhones, createdAt: Date.now() };
    });

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

    this.ctx.storage.transactionSync(() => {
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

      for (const item of prepared) {
        this.sql.exec(
          `INSERT INTO wabas (account_id, waba_id, meta_access_token, callback_url, created_at, status, provisioning_error)
           VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(waba_id) DO UPDATE SET
             account_id = excluded.account_id,
             meta_access_token = excluded.meta_access_token,
             callback_url = COALESCE(excluded.callback_url, wabas.callback_url),
             status = excluded.status,
             provisioning_error = NULL`,
          item.accountId,
          item.wabaId,
          item.metaAccessToken,
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

    return prepared.map((item) => {
      const waba = this.getWaba(item.accountId, item.wabaId);
      if (!waba) throw new Error(`WABA registration failed for "${item.wabaId}"`);
      return { waba, phones: waba.phones };
    });
  }

  /** Full registration incl. credentials + phones — only for the owning account. */
  getWaba(accountId: string, wabaId: string): AccountWaba | null {
    const id = this.requireAccount(accountId);
    const wabaIdN = validateWabaId(wabaId, "wabaId");
    const row = this.sql
      .exec(
        "SELECT account_id, waba_id, meta_access_token, callback_url, created_at, status, provisioning_error FROM wabas WHERE waba_id = ? AND account_id = ? AND status = 'active'",
        wabaIdN,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      accountId: row.account_id as string,
      wabaId: row.waba_id as string,
      metaAccessToken: row.meta_access_token as string,
      callbackUrl: (row.callback_url as string | null) ?? null,
      createdAt: row.created_at as number,
      status: (row.status as ProvisioningStatus) ?? "active",
      provisioningError: (row.provisioning_error as string | null) ?? null,
      phones: phonesOf(wabaIdN, this.sql),
    };
  }

  getWabaForProvisioning(accountId: string, wabaId: string): AccountWaba | null {
    const id = this.requireAccount(accountId);
    const wabaIdN = validateWabaId(wabaId, "wabaId");
    const row = this.sql
      .exec(
        "SELECT account_id, waba_id, meta_access_token, callback_url, created_at, status, provisioning_error FROM wabas WHERE waba_id = ? AND account_id = ?",
        wabaIdN,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      accountId: row.account_id as string,
      wabaId: row.waba_id as string,
      metaAccessToken: row.meta_access_token as string,
      callbackUrl: (row.callback_url as string | null) ?? null,
      createdAt: row.created_at as number,
      status: (row.status as ProvisioningStatus) ?? "active",
      provisioningError: (row.provisioning_error as string | null) ?? null,
      phones: phonesOf(wabaIdN, this.sql),
    };
  }

  /** Ownership metadata only — never the access token. */
  getWabaById(wabaId: string): WabaAccess | null {
    const wabaIdN = validateWabaId(wabaId, "wabaId");
    const row = this.sql
      .exec(
        "SELECT account_id, waba_id, callback_url, created_at, status, provisioning_error FROM wabas WHERE waba_id = ?",
        wabaIdN,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      accountId: row.account_id as string,
      wabaId: row.waba_id as string,
      callbackUrl: (row.callback_url as string | null) ?? null,
      createdAt: row.created_at as number,
      status: (row.status as ProvisioningStatus) ?? "active",
      provisioningError: (row.provisioning_error as string | null) ?? null,
      phones: phonesOf(wabaIdN, this.sql),
    };
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
        `SELECT w.waba_id, w.callback_url, w.created_at, w.status, w.provisioning_error,
                COALESCE(json_group_array(
                  json_object('phoneNumberId', p.phone_number_id,
                              'displayPhoneNumber', p.display_phone_number)), '[]') AS phones
         FROM wabas w
         LEFT JOIN phones p ON p.waba_id = w.waba_id
         WHERE w.account_id = ?
          GROUP BY w.waba_id, w.callback_url, w.created_at, w.status, w.provisioning_error
         ORDER BY w.waba_id`,
        id,
      )
      .toArray();
    const wabas: WabaAccess[] = wabaRows.map((row) => ({
      accountId: id,
      wabaId: row.waba_id as string,
      callbackUrl: (row.callback_url as string | null) ?? null,
      createdAt: row.created_at as number,
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

  /** Register a connect state; INSERT OR REPLACE so a retried start wins. */
  startConnectState(state: string, accountId: string, expiresAt: number, redirectUri?: string): void {
    const s = validateState(state);
    const id = this.requireAccount(accountId);
    const redirect = validateRedirectUri(redirectUri);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("invalid expiresAt: must be a future timestamp");
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO connect_states (state, account_id, expires_at, redirect_uri) VALUES (?, ?, ?, ?)",
      s,
      id,
      expiresAt,
      redirect,
    );
  }

  /** Single-use: returns the account once, then deletes the state. Expired or
   * unknown states are consumed (deleted) and return null. */
  consumeConnectState(state: string): string | null {
    return this.consumeConnectStateRecord(state)?.accountId ?? null;
  }

  consumeConnectStateRecord(state: string): ConnectStateRecord | null {
    const s = state?.trim() ?? "";
    if (!s || s.length > STATE_MAX_LENGTH) return null;
    const now = Date.now();
    let accountId: string | null = null;
    let redirectUri: string | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec(
          "SELECT account_id, expires_at, redirect_uri FROM connect_states WHERE state = ?",
          s,
        )
        .toArray()[0];
      if (!row) return;
      if ((row.expires_at as number) <= now) {
        this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
        return;
      }
      accountId = row.account_id as string;
      redirectUri = (row.redirect_uri as string | null) ?? null;
      this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
    });
    return accountId ? { accountId, redirectUri } : null;
  }

  getConnectStateAccount(state: string): string | null {
    return this.getConnectState(state)?.accountId ?? null;
  }

  getConnectState(state: string): ConnectStateRecord | null {
    const s = state?.trim() ?? "";
    if (!s || s.length > STATE_MAX_LENGTH) return null;
    const row = this.sql
      .exec("SELECT account_id, expires_at, redirect_uri FROM connect_states WHERE state = ?", s)
      .toArray()[0];
    if (!row) return null;
    if ((row.expires_at as number) <= Date.now()) {
      this.sql.exec("DELETE FROM connect_states WHERE state = ?", s);
      return null;
    }
    return {
      accountId: row.account_id as string,
      redirectUri: (row.redirect_uri as string | null) ?? null,
    };
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
