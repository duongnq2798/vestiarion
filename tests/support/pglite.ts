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
 * the three API roles the migrations grant and revoke against, and the
 * `auth.users` table that the tenancy tables reference.
 */
const SUPABASE_BASELINE = `
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
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
