import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0074 (docs/superpowers/specs/2026-10-05-network-foundation-design.md N1, N2, N4, N7): every workspace has
 * a network, locked once it went live or holds a Circle wallet; a payment intent takes its workspace's network; and the
 * open numbers count one network at a time, so Arc mainnet is never added to Arc testnet.
 */

let db: PGlite;
let testnetLive: string;
let mainnetLive: string;
let sandbox: string;

interface Side {
  workspacesOpened: number;
  liveWorkspaces: number;
  people: number;
  payments: number;
  usdcPaid: number;
  usdcInWallets: number;
  milestonesReleased: number;
}

async function org(slug: string, mode: "live" | "sandbox", createdBy: string | null, network?: string): Promise<string> {
  const result = network
    ? await db.query<{ id: string }>(
        "insert into public.orgs (slug, name, mode, created_by, created_at, network) values ($1, $1, $2, $3, '2026-09-20T00:00:00Z', $4) returning id",
        [slug, mode, createdBy, network]
      )
    : await db.query<{ id: string }>(
        "insert into public.orgs (slug, name, mode, created_by, created_at) values ($1, $1, $2, $3, '2026-09-20T00:00:00Z') returning id",
        [slug, mode, createdBy]
      );
  return result.rows[0].id;
}

async function counterparty(orgId: string, name: string): Promise<string> {
  const result = await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, 'vendor') returning id", [orgId, name]);
  return result.rows[0].id;
}

async function payable(orgId: string, counterpartyId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status)
     values ($1, 'payable', $2, 1, '2026-09-30T00:00:00Z', 'paid') returning id`,
    [orgId, counterpartyId]
  );
  return result.rows[0].id;
}

/** A confirmed live Circle payment; `network`, when given, is what the insert claims. */
async function payment(orgId: string, fields: { amount: number; at: string; invoiceId?: string; network?: string }): Promise<string> {
  const result = await db.query<{ network: string }>(
    `insert into public.payment_intents
       (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain${fields.network ? ", network" : ""})
     values ($1, 'invoice', coalesce($2::uuid, gen_random_uuid()), gen_random_uuid()::text, 'circle', 'live', $3, '0xAAA', 'confirmed', $4, '0xtx', 'ARC-TESTNET'${fields.network ? ", $5" : ""})
     returning network`,
    fields.network ? [orgId, fields.invoiceId ?? null, fields.amount, fields.at, fields.network] : [orgId, fields.invoiceId ?? null, fields.amount, fields.at]
  );
  return result.rows[0].network;
}

const sidesOf = async (fn: string, network: string | null): Promise<{ total: Side; customers: Side; ours: Side }> => {
  const sql = network === null ? `select public.${fn}(null::timestamptz) as n` : `select public.${fn}(null::timestamptz, $1) as n`;
  const rows = (await db.query<{ n: { sides: { total: Side; customers: Side; ours: Side } } }>(sql, network === null ? [] : [network])).rows;
  return rows[0].n.sides;
};

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  const team = await createUser(db, "team@vestiarion.test");
  const customer = await createUser(db, "owner@customer.test");
  const mainnetOwner = await createUser(db, "owner@mainnet.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");

  sandbox = await org("ours-sandbox", "sandbox", team);
  testnetLive = await org("cust-testnet", "live", customer);
  mainnetLive = await org("cust-mainnet", "live", mainnetOwner, "arc-mainnet");
  await db.query(
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner'), ($5, $6, 'owner')`,
    [sandbox, team, testnetLive, customer, mainnetLive, mainnetOwner]
  );

  await db.query(
    `insert into public.accounts (org_id, name, kind, chain, token, circle_wallet_id, balance, balance_synced_at)
     values ($1, 'Operating', 'operating', 'ARC-TESTNET', 'USDC', 'w-test', 40, '2026-09-29T10:00:00Z'),
            ($2, 'Operating', 'operating', 'ARC', 'USDC', 'w-main', 100, '2026-09-29T10:00:00Z')`,
    [testnetLive, mainnetLive]
  );

  const testnetVendor = await counterparty(testnetLive, "Acme");
  const mainnetVendor = await counterparty(mainnetLive, "Mainnet Vendor");
  await payment(testnetLive, { amount: 5, at: "2026-09-28T10:00:00Z", invoiceId: await payable(testnetLive, testnetVendor) });
  await payment(testnetLive, { amount: 3, at: "2026-09-29T10:00:00Z" });
  await payment(mainnetLive, { amount: 7, at: "2026-09-29T11:00:00Z", invoiceId: await payable(mainnetLive, mainnetVendor) });
});

describe("a workspace's network (N1, N2)", () => {
  it("is Arc testnet unless the workspace names another, and only one of the two", async () => {
    const plain = await org("plain", "sandbox", null);
    const row = await db.query<{ network: string }>("select network from public.orgs where id = $1", [plain]);
    expect(row.rows[0].network).toBe("arc-testnet");
    await expect(org("elsewhere", "sandbox", null, "arc-sepolia")).rejects.toThrow(/orgs_network_check/);
  });

  it("is locked once the workspace went live", async () => {
    await expect(db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [testnetLive])).rejects.toThrow(/network_locked/);
  });

  it("is locked once the workspace holds a Circle wallet, even as a sandbox", async () => {
    const withWallet = await org("wallet-sandbox", "sandbox", null);
    await db.query(
      "insert into public.accounts (org_id, name, kind, chain, token, circle_wallet_id, balance) values ($1, 'Operating', 'operating', 'ARC-TESTNET', 'USDC', 'w-sb', 0)",
      [withWallet]
    );
    await expect(db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [withWallet])).rejects.toThrow(/network_locked/);
  });

  it("may still change in a sandbox with no wallet", async () => {
    const empty = await org("empty-sandbox", "sandbox", null);
    await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [empty]);
    const row = await db.query<{ network: string }>("select network from public.orgs where id = $1", [empty]);
    expect(row.rows[0].network).toBe("arc-mainnet");
    await db.query("delete from public.orgs where id = $1", [empty]);
  });
});

describe("a payment's network (N4)", () => {
  it("is its workspace's, whatever the insert says", async () => {
    expect(await payment(mainnetLive, { amount: 0.5, at: "2026-09-30T10:00:00Z", network: "arc-testnet" })).toBe("arc-mainnet");
    expect(await payment(testnetLive, { amount: 0.5, at: "2026-09-30T10:00:00Z", network: "arc-mainnet" })).toBe("arc-testnet");
    await db.query("delete from public.payment_intents where executed_at = '2026-09-30T10:00:00Z'");
  });

  it("was Arc testnet for every intent before this migration", async () => {
    const column = await db.query<{ column_default: string; is_nullable: string }>(
      "select column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'payment_intents' and column_name = 'network'"
    );
    expect(column.rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(column.rows[0].column_default).toContain("arc-testnet");
  });
});

describe("the open numbers, one network at a time (N7)", () => {
  it("counts Arc testnet's workspaces, people, payments and wallets only", async () => {
    const { total } = await sidesOf("open_numbers", "arc-testnet");
    // Live: the founding workspace (0015) and the testnet one.
    expect(total).toMatchObject({ liveWorkspaces: 2, payments: 2, usdcPaid: 8, usdcInWallets: 40 });
    // The sandbox and the testnet workspace, with one owner each; never the mainnet owner.
    expect(total.people).toBe(2);
  });

  it("counts Arc mainnet's apart", async () => {
    const { total, customers } = await sidesOf("open_numbers", "arc-mainnet");
    expect(total).toMatchObject({ workspacesOpened: 1, liveWorkspaces: 1, people: 1, payments: 1, usdcPaid: 7, usdcInWallets: 100 });
    expect(customers.payments).toBe(1);
  });

  it("leaves the one-argument open_numbers as it was", async () => {
    const { total } = await sidesOf("open_numbers", null);
    expect(total.payments).toBe(3);
  });

  it("counts first payments per network", async () => {
    const testnet = (await sidesOf("open_first_payments", "arc-testnet")).total as unknown as { firstPayments: number };
    const mainnet = (await sidesOf("open_first_payments", "arc-mainnet")).total as unknown as { firstPayments: number };
    expect(testnet.firstPayments).toBe(1);
    expect(mainnet.firstPayments).toBe(1);
  });

  it("counts invoices paid per network in the outcomes", async () => {
    const testnet = (await sidesOf("open_outcomes", "arc-testnet")).total as unknown as { invoicesPaidOnArc: number };
    const mainnet = (await sidesOf("open_outcomes", "arc-mainnet")).total as unknown as { invoicesPaidOnArc: number };
    expect(testnet.invoicesPaidOnArc).toBe(1);
    expect(mainnet.invoicesPaidOnArc).toBe(1);
  });

  it("lets only the service role read them", async () => {
    const grants = await db.query<{ routine_name: string; grantee: string }>(
      `select routine_name, grantee from information_schema.routine_privileges
        where routine_schema = 'public' and routine_name in ('open_numbers', 'open_first_payments', 'open_outcomes')
          and grantee in ('anon', 'authenticated', 'public')`
    );
    expect(grants.rows).toEqual([]);
  });
});
