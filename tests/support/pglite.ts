import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { bodyHashOf, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";

export const FOUNDING_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/**
 * What Supabase provides that a vanilla Postgres does not, and nothing more:
 * the three API roles the migrations grant and revoke against, the
 * `auth.users` table that the tenancy tables reference, and the `extensions`
 * schema so 0018's conditional grant on it is exercised. pgcrypto itself
 * stays wherever PGlite loads it (below) — this schema is otherwise empty.
 */
const SUPABASE_BASELINE = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create role authenticator;
  create schema auth;
  create schema extensions;
  create table auth.users (id uuid primary key, email text);
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
}

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_BASELINE);
  return db;
}

export async function applyMigrations(db: PGlite, include: (file: string) => boolean = () => true): Promise<void> {
  for (const file of migrationFiles().filter(include)) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
}

/**
 * Signs the way `appendLedgerEntry` does and hands the body to the real Postgres function to link.
 * Calls the pre-0017 signature (no `p_org_id`): for tests of migrations before 0017 only.
 */
export async function appendSigned(
  db: PGlite,
  input: LedgerEntryInput,
  privateKey: crypto.KeyObject,
  signingKeyId: string | null = ledgerKeyId(privateKey)
): Promise<LedgerRow> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const result = await db.query<LedgerRow>(
    "select * from append_ledger_entry($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
    [input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, signingKeyId]
  );
  return result.rows[0];
}

/** As `appendSigned`, through the per-organization append that 0016 adds. */
export async function appendSignedForOrg(
  db: PGlite,
  orgId: string,
  input: LedgerEntryInput,
  privateKey: crypto.KeyObject,
  signingKeyId: string | null = ledgerKeyId(privateKey)
): Promise<LedgerRow> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const result = await db.query<LedgerRow>(
    "select * from append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)",
    [orgId, input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, signingKeyId]
  );
  return result.rows[0];
}

/** A second organization, for isolation tests. */
export async function createOrg(db: PGlite, slug: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into orgs (slug, name, mode) values ($1, $1, 'sandbox') returning id",
    [slug]
  );
  return result.rows[0].id;
}

/** A person, for tests that need someone to be `created_by` or a member. */
export async function createUser(db: PGlite, email: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id",
    [email]
  );
  return result.rows[0].id;
}

export const TENANT_TABLES = [
  "accounts", "counterparties", "invoices", "milestones", "treasury_actions", "compliance_checks",
  "forecasts", "ledger_entries", "payment_intents", "cycle_runs", "cycle_snapshots", "sim_clock", "gateway_signers",
] as const;

export interface SeededRows {
  counterpartyId: string;
  accountId: string;
  invoiceId: string;
  cycleRunId: string;
  idempotencyKey: string;
}

type Queryable = Pick<PGlite, "query">;

/** One row in every tenant table for `orgId`, written as the superuser (the service role's stand-in). */
export async function seedOrgRows(db: PGlite, orgId: string, tag: string): Promise<SeededRows> {
  const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0]?.id;
  const counterpartyId = await one(
    "insert into counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [orgId, `cp-${tag}`]);
  const accountId = await one(
    "insert into accounts (org_id, name, kind, chain) values ($1, $2, 'operating', 'ARC-TESTNET') returning id", [orgId, `acct-${tag}`]);
  const invoiceId = await one(
    "insert into invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
    [orgId, counterpartyId]);
  await db.query("insert into milestones (org_id, contractor_id, title, amount) values ($1, $2, $3, 1)", [orgId, counterpartyId, `m-${tag}`]);
  await db.query("insert into treasury_actions (org_id, action, amount, from_account) values ($1, 'rebalance', 1, $2)", [orgId, accountId]);
  await db.query("insert into compliance_checks (org_id, counterparty_id, risk_level, source) values ($1, $2, 'clear', 'test')", [orgId, counterpartyId]);
  await db.query(
    "insert into forecasts (org_id, as_of, horizon_days, projected_inflow, projected_outflow, liquid_balance) values ($1, now(), 7, 0, 0, 0)", [orgId]);
  const idempotencyKey = `k-${tag}`;
  await db.query(
    `insert into payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
     values ($1, 'invoice', $2, $3, 'simulate', 1, 'sim:x')`, [orgId, invoiceId, idempotencyKey]);
  const cycleRunId = await one(
    "insert into cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode) values ($1, now(), 'real', 'simulate', 'simulate') returning id",
    [orgId]);
  await db.query(
    `insert into cycle_snapshots (org_id, cycle_run_id, captured_at, account_balances, total_liquid, open_payables,
       open_receivables, obligations_due_7d, obligations_due_14d, reserve_position, chain_mode)
     values ($1, $2, now(), '{}'::jsonb, 0, 0, 0, 0, 0, 0, 'simulate')`, [orgId, cycleRunId]);
  await db.query("select advance_sim_day($1::uuid)", [orgId]);
  await db.query("insert into gateway_signers (org_id, circle_wallet_id, address) values ($1, $2, '0x' || repeat('ab', 20))", [orgId, `signer-${tag}`]);
  const key = crypto.generateKeyPairSync("ed25519");
  await appendSignedForOrg(db, orgId, { actor: "system", domain: "system", action: "note", summary: tag, detail: { tag } }, key.privateKey);
  return { counterpartyId, accountId, invoiceId, cycleRunId, idempotencyKey };
}

/**
 * Runs `fn` the way PostgREST runs a request made with a tenant token: as the
 * role `vestiarion_tenant`, with `request.jwt.claims` holding the token's
 * claims. `null` means a request whose token names no organization.
 */
export async function asTenant<T>(db: PGlite, orgId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = orgId ? { role: "vestiarion_tenant", org_id: orgId } : { role: "vestiarion_tenant" };
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    // PostgREST connects as authenticator and switches to vestiarion_tenant
    // from there, through the membership 0018 grants — not straight to the
    // target role — so this does the same, rather than jumping straight to
    // `set local role vestiarion_tenant`.
    await tx.query("set local role authenticator");
    await tx.query("set local role vestiarion_tenant");
    return fn(tx);
  });
}

/** Runs `fn` as one of the browser roles, which must have no access at all. */
export async function asRole<T>(db: PGlite, role: "anon" | "authenticated", fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    return fn(tx);
  });
}

/**
 * Runs `fn` as `service_role`, the way the server's own RPC calls run: RLS
 * applies to the connection but is bypassed through the role's BYPASSRLS
 * attribute (as on Supabase), rather than sidestepped by staying on PGlite's
 * superuser connection.
 */
export async function asServiceRole<T>(db: PGlite, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("set local role service_role");
    return fn(tx);
  });
}
