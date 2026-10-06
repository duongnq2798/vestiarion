import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0078 (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M3, M11): the database takes Arc
 * mainnet's chain, a workspace's network is fixed once it has an account, and the payment links name the workspace's
 * own chain.
 */

let db: PGlite;
const ADDRESS = "0x" + "ab".repeat(20);
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

async function org(slug: string, network = "arc-testnet", mode = "sandbox"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.orgs (slug, name, mode, network) values ($1, $1, $2, $3) returning id", [slug, mode, network])).rows[0].id;
}

async function account(orgId: string, chain: string, wallet: string | null = null): Promise<void> {
  await db.query(
    "insert into public.accounts (org_id, name, kind, chain, token, circle_wallet_id, address, balance) values ($1, 'Operating', 'operating', $2, 'USDC', $3, $4, 0)",
    [orgId, chain, wallet, wallet ? ADDRESS : null]
  );
}

async function counterparty(orgId: string, name: string, role: string, chain: string | null = null): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, chain) values ($1, $2, $3, $4) returning id", [orgId, name, role, chain])).rows[0].id;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

describe("a payee on Arc mainnet's chain (M11)", () => {
  it("is accepted for any role, while the Sepolia chains stay vendor-only and an unknown chain is refused", async () => {
    const main = await org("main-cp", "arc-mainnet");
    await counterparty(main, "Builder", "contractor", "ARC");
    await counterparty(main, "Supplier", "vendor", "ARC");
    await expect(counterparty(main, "Far", "contractor", "BASE-SEPOLIA")).rejects.toThrow(/counterparties_chain_check/);
    await expect(counterparty(main, "Odd", "vendor", "ARC-SEPOLIA")).rejects.toThrow(/counterparties_chain_check/);
  });

  it("survives 0044 running again, as db:migrate runs every file each time", async () => {
    const main = await org("main-rerun", "arc-mainnet");
    await counterparty(main, "Stays", "vendor", "ARC");
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0044_cctp_payouts.sql"), "utf8"));
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0078_mainnet_go_live.sql"), "utf8"));
    const row = await db.query<{ chain: string }>("select chain from public.counterparties where org_id = $1", [main]);
    expect(row.rows[0].chain).toBe("ARC");
  });
});

describe("the network is fixed once a workspace has an account (M3)", () => {
  it("may change while there is none, as createWorkspace sets it", async () => {
    const fresh = await org("fresh");
    await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [fresh]);
    expect((await db.query<{ network: string }>("select network from public.orgs where id = $1", [fresh])).rows[0].network).toBe("arc-mainnet");
  });

  it("is locked once a simulated account exists, so a testnet sandbox cannot be moved by hand", async () => {
    const sandbox = await org("hand-flip");
    await account(sandbox, "ARC-TESTNET");
    await expect(db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [sandbox])).rejects.toThrow(/network_locked/);
  });

  it("still lets every other column of the row change", async () => {
    const sandbox = await org("renamed");
    await account(sandbox, "ARC-TESTNET");
    await db.query("update public.orgs set name = 'Renamed' where id = $1", [sandbox]);
    expect((await db.query<{ name: string }>("select name from public.orgs where id = $1", [sandbox])).rows[0].name).toBe("Renamed");
  });
});

describe("the payment links on Arc mainnet (M11)", () => {
  it("pays into the operating account on ARC, and names it", async () => {
    const main = await org("main-links", "arc-mainnet", "live");
    await account(main, "ARC", "w-main");
    const client = await counterparty(main, "Client", "client");
    const invoice = (
      await db.query<{ id: string }>(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) values ($1, 'receivable', $2, 5, '2026-10-20T12:00:00Z', 'pending') returning id",
        [main, client]
      )
    ).rows[0].id;
    await db.query("insert into public.receivable_links (org_id, invoice_id, token_hash) values ($1, $2, $3)", [main, invoice, hash("a")]);
    const preview = (await db.query<{ p: { chain: string; payTo: string | null } }>("select public.pay_link_preview($1) as p", [hash("a")])).rows[0].p;
    expect(preview).toMatchObject({ chain: "ARC", payTo: ADDRESS });
  });

  it("still pays into Arc testnet's operating account on a testnet workspace", async () => {
    const test = await org("test-links", "arc-testnet", "live");
    await account(test, "ARC-TESTNET", "w-test");
    const client = await counterparty(test, "Client", "client");
    const invoice = (
      await db.query<{ id: string }>(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) values ($1, 'receivable', $2, 5, '2026-10-20T12:00:00Z', 'pending') returning id",
        [test, client]
      )
    ).rows[0].id;
    await db.query("insert into public.receivable_links (org_id, invoice_id, token_hash) values ($1, $2, $3)", [test, invoice, hash("b")]);
    const preview = (await db.query<{ p: { chain: string; payTo: string | null } }>("select public.pay_link_preview($1) as p", [hash("b")])).rows[0].p;
    expect(preview).toMatchObject({ chain: "ARC-TESTNET", payTo: ADDRESS });
  });

  it("names the workspace's own chain for a payee who has none", async () => {
    const main = await org("main-payee", "arc-mainnet", "live");
    const payee = await counterparty(main, "Payee", "contractor");
    await db.query("insert into public.payee_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 day')", [main, payee, hash("c")]);
    expect((await db.query<{ s: { chain: string } }>("select public.payee_link_status($1) as s", [hash("c")])).rows[0].s.chain).toBe("ARC");

    const test = await org("test-payee", "arc-testnet", "live");
    const testPayee = await counterparty(test, "Payee", "contractor");
    await db.query("insert into public.payee_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 day')", [test, testPayee, hash("d")]);
    expect((await db.query<{ s: { chain: string } }>("select public.payee_link_status($1) as s", [hash("d")])).rows[0].s.chain).toBe("ARC-TESTNET");
  });
});

describe("the network column's comment (mainnet limits L8, 0079)", () => {
  it("says the network is fixed once the workspace has an account", async () => {
    const row = await db.query<{ comment: string }>("select col_description('public.orgs'::regclass, (select attnum from pg_attribute where attrelid = 'public.orgs'::regclass and attname = 'network')) as comment");
    expect(row.rows[0].comment).toContain("once it has an account");
  });
});
