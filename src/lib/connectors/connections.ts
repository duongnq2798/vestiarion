import { db } from "../dal";
import type { ProviderId } from "./provider";
import type { ConnectionState } from "./status";

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
