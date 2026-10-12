import { db, platformDb } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { PROVIDER_LABELS, providerKind, type ExternalOrganisation, type ProviderId } from "./provider";
import type { Consent } from "./state";
import type { ConnectionState } from "./status";
import { deleteTokens, refreshTokenOf } from "./token-store";

/**
 * A workspace's connection to an accounting provider (docs/superpowers/specs/2026-10-12-xero-connector-design.md X2,
 * X15, X16), read and written through the DAL in the workspace's own scope: `accounting_connections` is a tenant table
 * and holds no token. Before migration 0101 has run, a read says the feature is not set up rather than failing.
 */

/** Where payments made on Arc will be booked (I14). */
export interface PaymentAccount {
  id: string;
  code: string | null;
  name: string;
  currency: string | null;
}

export interface Connection {
  id: string;
  orgId: string;
  provider: ProviderId;
  externalOrgId: string;
  externalOrgName: string | null;
  status: ConnectionState;
  scopes: string[];
  connectedBy: string | null;
  connectedAt: string;
  consentVersion: string;
  consentedAt: string;
  revokedAt: string | null;
  windowFrom: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  failures: number;
  nextSyncAfter: string | null;
  syncLeaseUntil: string | null;
  paymentAccount: PaymentAccount | null;
  paymentAccountAt: string | null;
}

export interface ConnectionRow {
  id: string;
  org_id: string;
  provider: ProviderId;
  external_org_id: string;
  external_org_name: string | null;
  status: ConnectionState;
  scopes: string[] | null;
  connected_by: string | null;
  connected_at: string;
  consent_version: string;
  consented_at: string;
  revoked_at: string | null;
  window_from: string;
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  failures: number;
  next_sync_after: string | null;
  sync_lease_until: string | null;
  payment_account: unknown;
  payment_account_at: string | null;
}

export const CONNECTION_COLUMNS =
  "id, org_id, provider, external_org_id, external_org_name, status, scopes, connected_by, connected_at, consent_version, consented_at, revoked_at, window_from, last_synced_at, last_error, last_error_at, failures, next_sync_after, sync_lease_until, payment_account, payment_account_at";

function paymentAccountOf(value: unknown): PaymentAccount | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, code, name, currency } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return { id, code: typeof code === "string" ? code : null, name, currency: typeof currency === "string" ? currency : null };
}

export function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    externalOrgId: row.external_org_id,
    externalOrgName: row.external_org_name,
    status: row.status,
    scopes: row.scopes ?? [],
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
    consentVersion: row.consent_version,
    consentedAt: row.consented_at,
    revokedAt: row.revoked_at,
    windowFrom: String(row.window_from).slice(0, 10),
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    failures: Number(row.failures ?? 0),
    nextSyncAfter: row.next_sync_after,
    syncLeaseUntil: row.sync_lease_until,
    paymentAccount: paymentAccountOf(row.payment_account),
    paymentAccountAt: row.payment_account_at,
  };
}

/** A table or function migration 0101 adds, missing because the migration has not run here yet. */
export function isNotSetUp(error: { code?: string | null; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code && ["PGRST205", "PGRST202", "42P01", "42883"].includes(error.code)) return true;
  return /could not find the (table|function)|does not exist/i.test(error.message ?? "");
}

/** The feature's tables are not in this database yet (X16). */
export class NotSetUpError extends Error {
  constructor() {
    super("The accounting connector tables are not in this database yet");
    this.name = "NotSetUpError";
  }
}

function raise(error: { code?: string | null; message: string }): never {
  if (isNotSetUp(error)) throw new NotSetUpError();
  throw new Error(error.message);
}

/**
 * The workspace's connection to a provider: the one not revoked, else the latest revoked one, so the card can say it
 * was disconnected; null when it never connected.
 */
export async function connectionFor(provider: ProviderId): Promise<Connection | null> {
  const result = await db()
    .from("accounting_connections")
    .select(CONNECTION_COLUMNS)
    .eq("provider", provider)
    .order("created_at", { ascending: false })
    .limit(20);
  if (result.error) raise(result.error);
  const rows = (result.data ?? []) as unknown as ConnectionRow[];
  const active = rows.find((row) => row.status !== "revoked");
  const latestRevoked = [...rows].filter((row) => row.status === "revoked").sort((a, b) => (b.revoked_at ?? "").localeCompare(a.revoked_at ?? ""))[0];
  const row = active ?? latestRevoked;
  return row ? toConnection(row) : null;
}

export async function connectionById(id: string): Promise<Connection | null> {
  const result = await db().from("accounting_connections").select(CONNECTION_COLUMNS).eq("id", id).limit(1);
  if (result.error) raise(result.error);
  const row = ((result.data ?? []) as unknown as ConnectionRow[])[0];
  return row ? toConnection(row) : null;
}

/** The bills of a connection waiting for a person: in review, and still open in the provider. */
export async function waitingCount(connectionId: string): Promise<number> {
  const result = await db()
    .from("accounting_bills")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connectionId)
    .eq("review_state", "review")
    .eq("source_status", "open");
  if (result.error) raise(result.error);
  return result.count ?? 0;
}

const DAY_MS = 86_400_000;
/** How far back a first connection brings bills in (X9). */
export const WINDOW_DAYS = 90;

export type SaveConnection =
  | { ok: true; connection: Connection; reconnected: boolean }
  | { ok: false; reason: "other_organisation"; name: string | null }
  /** Another workspace connected the same organisation a moment before (migration 0102's index, Q5; 0105's, HubSpot H4). */
  | { ok: false; reason: "other_workspace"; name: null };

/**
 * Connects the workspace to an organisation of a provider (X4): a new connection, or the same organisation's own row
 * again (one that needs reconnecting, or was disconnected), keeping its links, cursors and review list. A workspace
 * already connected to another organisation of the provider is refused. Records `accounting_connected`, with the
 * consent the person gave. Tokens are kept apart, by `token-store.ts`.
 */
export async function saveConnection(input: {
  provider: ProviderId;
  organisation: ExternalOrganisation;
  connectedBy: string;
  scopes: string[];
  consent: Consent;
  nowMs?: number;
}): Promise<SaveConnection> {
  const nowMs = input.nowMs ?? Date.now();
  const result = await db().from("accounting_connections").select(CONNECTION_COLUMNS).eq("provider", input.provider);
  if (result.error) raise(result.error);
  const rows = (result.data ?? []) as unknown as ConnectionRow[];
  const active = rows.find((row) => row.status !== "revoked");
  if (active && active.external_org_id !== input.organisation.externalOrgId) return { ok: false, reason: "other_organisation", name: active.external_org_name };
  const existing = rows.find((row) => row.external_org_id === input.organisation.externalOrgId);
  const values = {
    external_org_name: input.organisation.name,
    status: "connected",
    scopes: input.scopes,
    connected_by: input.connectedBy,
    connected_at: new Date(nowMs).toISOString(),
    consent_version: input.consent.version,
    consented_at: input.consent.at,
    revoked_at: null,
    revoked_by: null,
    last_error: null,
    last_error_at: null,
    failures: 0,
    next_sync_after: null,
    sync_lease_until: null,
  };
  const saved = existing
    ? await db().from("accounting_connections").update(values).eq("id", existing.id).select(CONNECTION_COLUMNS)
    : await db()
        .from("accounting_connections")
        .insert({
          ...values,
          provider: input.provider,
          external_org_id: input.organisation.externalOrgId,
          window_from: new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10),
        })
        .select(CONNECTION_COLUMNS);
  if (saved.error) {
    if (saved.error.code === "23505" && /one_workspace/.test(saved.error.message)) return { ok: false, reason: "other_workspace", name: null };
    raise(saved.error);
  }
  const connection = toConnection(((saved.data ?? []) as unknown as ConnectionRow[])[0]);
  const label = PROVIDER_LABELS[input.provider];
  // A CRM's won deals come in to be planned; an accounting tool's bills to be added (HubSpot connector H19).
  const comesIn = providerKind(input.provider) === "crm" ? "Its won deals come in to plan collections on Bills & receivables" : "Its bills come in for review on Bills & receivables";
  await appendLedgerEntryBestEffort(connection.orgId, {
    actor: "human",
    domain: "system",
    action: "accounting_connected",
    summary: `Connected ${label}: ${input.organisation.name}. ${comesIn}`,
    detail: {
      by: input.connectedBy,
      provider: input.provider,
      connectionId: connection.id,
      externalOrgId: input.organisation.externalOrgId,
      externalOrgName: input.organisation.name,
      scopes: input.scopes,
      consent: { version: input.consent.version, at: input.consent.at },
      reconnected: existing !== undefined,
    },
  });
  return { ok: true, connection, reconnected: existing !== undefined };
}

/**
 * Disconnects (X13): the refresh token is revoked at the provider first (best effort, outside any write), then the
 * tokens are deleted and the connection marked revoked, keeping its history. Records `accounting_disconnected`.
 *
 * With `atProvider`, the provider has said the connection no longer works because it was disconnected there
 * (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q12): nothing is revoked, the rest is the same, and
 * the entry says so. Then a connection another request revoked first is left as it is, with no second entry.
 */
export async function disconnectConnection(input: {
  connection: Connection;
  by: string;
  revoke: (refreshToken: string) => Promise<boolean>;
  nowMs?: number;
  atProvider?: boolean;
}): Promise<{ revokedAtProvider: boolean }> {
  const { connection } = input;
  let revokedAtProvider = input.atProvider === true;
  if (!input.atProvider) {
    try {
      const refreshToken = await refreshTokenOf(connection.orgId, { connectionId: connection.id });
      if (refreshToken) revokedAtProvider = await input.revoke(refreshToken);
    } catch (error) {
      console.error("connector: revoking at the provider failed", connection.id, error instanceof Error ? error.message : "unknown error");
    }
  }
  await deleteTokens(connection.orgId, { connectionId: connection.id });
  const updated = await db()
    .from("accounting_connections")
    .update({ status: "revoked", revoked_at: new Date(input.nowMs ?? Date.now()).toISOString(), revoked_by: input.by, sync_lease_until: null, next_sync_after: null })
    .eq("id", connection.id)
    .neq("status", "revoked")
    .select("id");
  if (updated.error) raise(updated.error);
  if (input.atProvider && (updated.data ?? []).length === 0) return { revokedAtProvider };
  const label = PROVIDER_LABELS[connection.provider];
  const name = connection.externalOrgName ?? connection.externalOrgId;
  await appendLedgerEntryBestEffort(connection.orgId, {
    actor: "human",
    domain: "system",
    action: "accounting_disconnected",
    summary: input.atProvider ? `${label} says it was disconnected there: ${name}` : `Disconnected ${label}: ${name}`,
    detail: {
      by: input.by,
      provider: connection.provider,
      connectionId: connection.id,
      externalOrgId: connection.externalOrgId,
      revokedAtProvider,
      ...(input.atProvider ? { atProvider: true } : {}),
    },
  });
  return { revokedAtProvider };
}

/** A connection found by the provider's own organisation id, across workspaces: ids, a status and a time, nothing else. */
export interface ExternalMatch {
  orgId: string;
  connectionId: string;
  externalOrgId: string;
  status: ConnectionState;
  nextSyncAfter: string | null;
}

/**
 * The connections, not revoked, of these organisations of a provider in every workspace (migration 0102's
 * `accounting_connections_by_external`, the service role's): for QuickBooks' webhook, which names a company and no
 * workspace (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q11), and the connect flow's check (Q5;
 * HubSpot connector H4).
 */
export async function connectionsByExternal(provider: ProviderId, externalOrgIds: readonly string[]): Promise<ExternalMatch[]> {
  if (externalOrgIds.length === 0) return [];
  const result = await platformDb().rpc("accounting_connections_by_external", { p_provider: provider, p_external_org_ids: [...externalOrgIds] });
  if (result.error) raise(result.error);
  return ((result.data ?? []) as Array<{ org_id: string; connection_id: string; external_org_id: string; status: ConnectionState; next_sync_after: string | null }>).map(
    (row) => ({ orgId: row.org_id, connectionId: row.connection_id, externalOrgId: row.external_org_id, status: row.status, nextSyncAfter: row.next_sync_after })
  );
}

/** Whether another workspace holds a connection, not revoked, to this organisation (Q5): yes or no, never which. */
export async function connectedElsewhere(provider: ProviderId, externalOrgId: string, orgId: string): Promise<boolean> {
  return (await connectionsByExternal(provider, [externalOrgId])).some((match) => match.orgId !== orgId);
}

/** Keeps the account payments made on Arc will be booked to (I14), and records `accounting_payment_account_chosen`. */
export async function choosePaymentAccount(input: { connection: Connection; account: PaymentAccount; by: string; nowMs?: number }): Promise<void> {
  const { connection, account } = input;
  const updated = await db()
    .from("accounting_connections")
    .update({ payment_account: account, payment_account_by: input.by, payment_account_at: new Date(input.nowMs ?? Date.now()).toISOString() })
    .eq("id", connection.id)
    .eq("status", "connected")
    .select("id");
  if (updated.error) raise(updated.error);
  await appendLedgerEntryBestEffort(connection.orgId, {
    actor: "human",
    domain: "system",
    action: "accounting_payment_account_chosen",
    summary: `Chose where payments made on Arc will be booked in ${PROVIDER_LABELS[connection.provider]}: ${account.name}${account.code ? ` (${account.code})` : ""}`,
    detail: { by: input.by, provider: connection.provider, connectionId: connection.id, account },
  });
}
