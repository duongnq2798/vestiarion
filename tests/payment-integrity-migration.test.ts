import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHashOf, type LedgerEntryInput } from "@/lib/ledger";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0077 (docs/superpowers/specs/2026-10-05-payment-integrity-design.md I1–I3): the claim that lets whoever
 * entered a payable give its second approval counts only an approval that agrees and stands, `approvers_besides` answers
 * null for another workspace and ignores nulls, and the ledger is appended only through `append_ledger_entry`.
 */

type Tx = Parameters<Parameters<typeof asTenant>[2]>[0];

let db: PGlite;
let owner: string, approver: string, admin: string, viewer: string;
let org: string, other: string;
let counterpartyId: string;
const KEY = crypto.generateKeyPairSync("ed25519").privateKey;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "integrity-owner@example.com");
  approver = await createUser(db, "integrity-approver@example.com");
  admin = await createUser(db, "integrity-admin@example.com");
  viewer = await createUser(db, "integrity-viewer@example.com");
  org = await createOrg(db, "integrity-co");
  other = await createOrg(db, "integrity-other");
  for (const [user, role] of [[owner, "owner"], [approver, "approver"], [admin, "admin"], [viewer, "viewer"]] as const) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [org, user, role]);
  }
  counterpartyId = (await seedOrgRows(db, org, "integrity")).counterpartyId;
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function heldInvoice(createdBy: string, currency = "USDC"): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, currency, due_date, status, created_by)
     values ($1, 'payable', $2, 120, $3, now(), 'held', $4) returning id`,
    [org, counterpartyId, currency, createdBy]
  );
  return result.rows[0].id;
}

const approve = (invoiceId: string, by: string, amount = 120, currency = "USDC") =>
  db.query(
    `insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency, address)
     values ($1, 'invoice', $2, $3, $4, $5, '0xabc')`,
    [org, invoiceId, by, amount, currency]
  );

const claim = (actor: string, invoiceId: string) =>
  asTenant(db, org, async (tx) =>
    (await tx.query<{ status: string }>("select status from public.claim_invoice_decision($1, $2, $3, 'approve')", [org, invoiceId, actor])).rows[0]);

/** Whether whoever entered a payable may claim it on a matching approval (I1), for the replay test. */
async function claimable(): Promise<boolean> {
  const invoiceId = await heldInvoice(admin);
  await approve(invoiceId, approver, 100);
  try {
    await claim(admin, invoiceId);
    return false;
  } catch (error) {
    return /self_approval/.test((error as Error).message);
  }
}

describe("claim_invoice_decision counts only an approval that agrees and stands (0077, I1)", () => {
  it("counts a matching approval in EURC for a EURC payable", async () => {
    const invoiceId = await heldInvoice(admin, "EURC");
    await approve(invoiceId, approver, 120, "EURC");
    expect((await claim(admin, invoiceId)).status).toBe("processing");
  });

  it("lets whoever entered it give the second approval on another person's open approval of this payment", async () => {
    const invoiceId = await heldInvoice(admin);
    await approve(invoiceId, approver);
    expect((await claim(admin, invoiceId)).status).toBe("processing");
  });

  it("refuses them on an approval of another amount", async () => {
    const invoiceId = await heldInvoice(admin);
    await approve(invoiceId, approver, 100);
    await expect(claim(admin, invoiceId)).rejects.toThrow(/self_approval/);
  });

  it("refuses them on an approval in another currency", async () => {
    const invoiceId = await heldInvoice(admin);
    await approve(invoiceId, approver, 120, "EURC");
    await expect(claim(admin, invoiceId)).rejects.toThrow(/self_approval/);
  });

  it("refuses them on an approval by someone who may no longer approve payments", async () => {
    const invoiceId = await heldInvoice(admin);
    await approve(invoiceId, viewer);
    await expect(claim(admin, invoiceId)).rejects.toThrow(/self_approval/);
  });
});

describe("approvers_besides (0077, I2)", () => {
  const besides = (tokenOrg: string | null, orgId: string, excluded: Array<string | null>) =>
    asTenant(db, tokenOrg, async (tx) =>
      (await tx.query<{ n: number | null }>("select public.approvers_besides($1, $2::uuid[]) as n", [orgId, excluded])).rows[0].n);

  it("answers null for another workspace than the token's, so the app refuses rather than counting no one", async () => {
    expect(await besides(other, org, [])).toBeNull();
  });

  it("ignores a null in the list rather than counting no one", async () => {
    expect(await besides(org, org, [owner, null])).toBe(2);
    expect(await besides(org, org, [null])).toBe(3);
  });
});

describe("a tenant's ledger insert must link the chain as append_ledger_entry links it (0077, I3)", () => {
  const entry = (action: string): LedgerEntryInput => ({ actor: "agent", domain: "treasury", action, summary: action, detail: { n: action } });
  const signed = (input: LedgerEntryInput) => {
    const bodyHash = bodyHashOf(input);
    return { bodyHash, signature: crypto.sign(null, Buffer.from(bodyHash, "hex"), KEY).toString("hex") };
  };
  const chainStep = (prev: string, bodyHash: string, signature: string) => crypto.createHash("sha256").update(`${prev}${bodyHash}${signature}`).digest("hex");
  type Row = { seq: number; ts: string; prev_hash: string; hash: string; body_hash: string; signature: string; org_id: string };
  async function append(tx: Tx, orgId: string, input: LedgerEntryInput) {
    const { bodyHash, signature } = signed(input);
    const result = await tx.query<Row>("select * from public.append_ledger_entry($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)", [
      orgId, input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, null,
    ]);
    return result.rows[0];
  }
  const head = async (orgId: string) =>
    (await db.query<{ hash: string }>("select hash from public.ledger_entries where org_id = $1 order by seq desc limit 1", [orgId])).rows[0]?.hash ?? "0".repeat(64);
  async function insertDirect(tx: Tx, orgId: string, input: LedgerEntryInput, link: { prev: string; hash?: string; ts?: string }) {
    const { bodyHash, signature } = signed(input);
    const result = await tx.query<Row>(
      `insert into public.ledger_entries (org_id, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash${link.ts ? ", ts" : ""})
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10${link.ts ? ", $11" : ""}) returning *`,
      [orgId, input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, link.prev, link.hash ?? chainStep(link.prev, bodyHash, signature), ...(link.ts ? [link.ts] : [])]
    );
    return result.rows[0];
  }

  it("appends through the function exactly as before, each entry linked to the last", async () => {
    const first = await asTenant(db, org, (tx) => append(tx, org, entry("first")));
    const second = await asTenant(db, org, (tx) => append(tx, org, entry("second")));
    expect(second.org_id).toBe(org);
    expect(second.prev_hash).toBe(first.hash);
    expect(second.hash).toBe(chainStep(second.prev_hash, second.body_hash, second.signature));
  });

  it("refuses a tenant's direct insert that does not follow the workspace's last entry", async () => {
    await expect(asTenant(db, org, (tx) => insertDirect(tx, org, entry("forked"), { prev: "0".repeat(64) }))).rejects.toThrow(
      /an entry must link the chain as append_ledger_entry links it/
    );
  });

  it("refuses one whose hash is not the chain step", async () => {
    const prev = await head(org);
    await expect(asTenant(db, org, (tx) => insertDirect(tx, org, entry("bad-hash"), { prev, hash: "f".repeat(64) }))).rejects.toThrow(
      /an entry must link the chain as append_ledger_entry links it/
    );
  });

  it("takes a linked direct insert as the function would, at the time of the insert rather than one it names", async () => {
    const prev = await head(org);
    const row = await asTenant(db, org, (tx) => insertDirect(tx, org, entry("linked"), { prev, ts: "2020-01-01T00:00:00Z" }));
    expect(row.prev_hash).toBe(prev);
    expect(Date.parse(row.ts)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    // The function still follows it.
    const next = await asTenant(db, org, (tx) => append(tx, org, entry("after")));
    expect(next.prev_hash).toBe(row.hash);
  });

  it("still refuses an append for another workspace, and still lets the server's own roles write", async () => {
    await expect(asTenant(db, org, (tx) => append(tx, other, entry("elsewhere")))).rejects.toThrow(/row-level security/);
    expect((await asServiceRole(db, (tx) => append(tx, other, entry("server")))).org_id).toBe(other);
    // The platform's own connection is trusted, as migrations and backfills are.
    await db.query(
      `insert into public.ledger_entries (org_id, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash)
       values ($1, 'system', 'treasury', 'backfill', 'backfill', '{}', 'b', 's', 'p', 'h')`,
      [other]
    );
    await expect(asRole(db, "anon", (tx) => append(tx, org, entry("anon")))).rejects.toThrow(/permission denied/);
  });

  it("keeps all of it when every migration is replayed, as the runner does on each run", async () => {
    await applyMigrations(db);
    const before = await head(org);
    const after = await asTenant(db, org, (tx) => append(tx, org, entry("replayed")));
    expect(after.prev_hash).toBe(before);
    expect(after.hash).toBe(chainStep(after.prev_hash, after.body_hash, after.signature));
    await expect(asTenant(db, org, (tx) => insertDirect(tx, org, entry("forked-again"), { prev: "0".repeat(64) }))).rejects.toThrow(
      /an entry must link the chain as append_ledger_entry links it/
    );
    expect(await claimable()).toBe(true);
  }, 60_000);
});
