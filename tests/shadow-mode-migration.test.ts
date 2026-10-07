import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0084 (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1, S3, S6, S7, S9): the shadow mode switch,
 * one verdict per agent decision, a bill's own currency beside the USDC it is paid in, and a supplier's mirror wallet.
 * The tables are seen and written only by their own workspace.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const startShadow = (orgId: string, currency: string) =>
  db.query(
    `insert into public.shadow_modes (org_id, currency) values ($1, $2)
     on conflict (org_id) do update set currency = excluded.currency`,
    [orgId, currency]
  );

const verdict = (orgId: string, seq: number, fields: { verdict?: string; reason?: string | null; subject?: string } = {}) =>
  db.query(
    `insert into public.decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict, reason)
     values ($1, $2, $3, gen_random_uuid(), 'ap_pay', $4, $5)`,
    [orgId, seq, fields.subject ?? "invoice", fields.verdict ?? "agree", fields.reason === undefined ? null : fields.reason]
  );

async function payable(orgId: string, original: { currency: string | null; amount: number | null; rate: number | null; source: string | null; at: string | null }) {
  const counterparty = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Supplier', 'vendor') returning id", [orgId])).rows[0].id;
  return db.query(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, original_currency, original_amount, fx_rate, fx_source, fx_at)
     values ($1, 'payable', $2, 96.39, now(), $3, $4, $5, $6, $7)`,
    [orgId, counterparty, original.currency, original.amount, original.rate, original.source, original.at]
  );
}

const VND = { currency: "VND", amount: 2_500_000, rate: 25_935.897512, source: "open.er-api.com", at: "2026-10-07T00:02:32Z" };

describe("shadow_modes in USDC (0085)", () => {
  it("takes USDC as a workspace's currency, and still refuses EURC and a code in lower case", async () => {
    const orgId = await createOrg(db, "shadow-usdc");
    await startShadow(orgId, "USDC");
    const rows = (await db.query<{ currency: string }>("select currency from public.shadow_modes where org_id = $1", [orgId])).rows;
    expect(rows).toEqual([{ currency: "USDC" }]);
    await expect(startShadow(orgId, "EURC")).rejects.toThrow(/shadow_modes_currency_check/);
    await expect(startShadow(orgId, "usdc")).rejects.toThrow(/shadow_modes_currency_check/);
  });
});

describe("shadow_modes (0084)", () => {
  it("holds one row per workspace, in a currency of three capital letters", async () => {
    const orgId = await createOrg(db, "shadow-one");
    await startShadow(orgId, "VND");
    await startShadow(orgId, "USD");
    const rows = (await db.query<{ currency: string }>("select currency from public.shadow_modes where org_id = $1", [orgId])).rows;
    expect(rows).toEqual([{ currency: "USD" }]);
    await expect(startShadow(orgId, "vnd")).rejects.toThrow(/shadow_modes_currency_check/);
    await expect(startShadow(orgId, "VNDX")).rejects.toThrow(/shadow_modes_currency_check/);
  });

  it("goes with its workspace", async () => {
    const orgId = await createOrg(db, "shadow-gone");
    await startShadow(orgId, "VND");
    await db.query("delete from public.orgs where id = $1", [orgId]);
    expect((await db.query("select 1 from public.shadow_modes where org_id = $1", [orgId])).rows).toHaveLength(0);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "shadow-tenant-a");
    const theirs = await createOrg(db, "shadow-tenant-b");
    await startShadow(mine, "VND");
    await startShadow(theirs, "THB");
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ currency: string }>("select currency from public.shadow_modes")).rows);
    expect(seen).toEqual([{ currency: "VND" }]);
    await expect(asTenant(db, mine, (tx) => tx.query("insert into public.shadow_modes (org_id, currency) values ($1, 'EUR')", [theirs]))).rejects.toThrow();
  });
});

describe("decision_verdicts (0084)", () => {
  it("keeps one verdict per decision entry", async () => {
    const orgId = await createOrg(db, "verdict-once");
    await verdict(orgId, 101);
    await expect(verdict(orgId, 101, { verdict: "disagree", reason: "Paid on the due date" })).rejects.toThrow(/decision_verdicts_org_id_entry_seq_key/);
    await verdict(orgId, 102, { verdict: "disagree", reason: "Paid on the due date" });
    expect((await db.query("select 1 from public.decision_verdicts where org_id = $1", [orgId])).rows).toHaveLength(2);
  });

  it("takes agree or disagree, about an invoice or a milestone, with a reason of at most 280 characters", async () => {
    const orgId = await createOrg(db, "verdict-checks");
    await expect(verdict(orgId, 201, { verdict: "maybe" })).rejects.toThrow(/decision_verdicts_verdict_check/);
    await expect(verdict(orgId, 202, { subject: "receivable" })).rejects.toThrow(/decision_verdicts_subject_check/);
    await expect(verdict(orgId, 203, { reason: "" })).rejects.toThrow(/decision_verdicts_reason_check/);
    await expect(verdict(orgId, 204, { reason: "x".repeat(281) })).rejects.toThrow(/decision_verdicts_reason_check/);
    await verdict(orgId, 205, { reason: "x".repeat(280) });
    await verdict(orgId, 206, { subject: "milestone" });
  });

  it("goes with its workspace, and is seen only by it", async () => {
    const mine = await createOrg(db, "verdict-tenant-a");
    const theirs = await createOrg(db, "verdict-tenant-b");
    await verdict(mine, 301);
    await verdict(theirs, 302);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ entry_seq: string }>("select entry_seq from public.decision_verdicts")).rows);
    expect(seen.map((row) => Number(row.entry_seq))).toEqual([301]);
    await db.query("delete from public.orgs where id = $1", [theirs]);
    expect((await db.query("select 1 from public.decision_verdicts where org_id = $1", [theirs])).rows).toHaveLength(0);
  });
});

describe("a bill's own currency on invoices (0084)", () => {
  it("keeps the bill's currency, amount, rate, source and time together, or none of them", async () => {
    const orgId = await createOrg(db, "original-currency");
    await payable(orgId, VND);
    await payable(orgId, { currency: null, amount: null, rate: null, source: null, at: null });
    await expect(payable(orgId, { ...VND, rate: null })).rejects.toThrow(/invoices_original_complete/);
    await expect(payable(orgId, { ...VND, source: null })).rejects.toThrow(/invoices_original_complete/);
  });

  it("refuses USDC or EURC as a bill's own currency, and a figure of zero or less", async () => {
    const orgId = await createOrg(db, "original-checks");
    await expect(payable(orgId, { ...VND, currency: "USDC" })).rejects.toThrow(/invoices_original_currency_check/);
    await expect(payable(orgId, { ...VND, currency: "EURC" })).rejects.toThrow(/invoices_original_currency_check/);
    await expect(payable(orgId, { ...VND, currency: "vnd" })).rejects.toThrow(/invoices_original_currency_check/);
    await expect(payable(orgId, { ...VND, amount: 0 })).rejects.toThrow(/invoices_original_amount_check/);
    await expect(payable(orgId, { ...VND, rate: 0 })).rejects.toThrow(/invoices_fx_rate_check/);
  });
});

describe("a supplier's mirror wallet (0084)", () => {
  it("names the Circle wallet Vestiarion made for a supplier", async () => {
    const orgId = await createOrg(db, "mirror-wallet");
    const rows = (
      await db.query<{ mirror_wallet_id: string }>(
        "insert into public.counterparties (org_id, name, role, mirror_wallet_id) values ($1, 'Supplier', 'vendor', 'wallet-1') returning mirror_wallet_id",
        [orgId]
      )
    ).rows;
    expect(rows).toEqual([{ mirror_wallet_id: "wallet-1" }]);
  });
});
