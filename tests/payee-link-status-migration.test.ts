import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0053 (docs/superpowers/specs/2026-10-02-freelancer-journey-design.md R1, R2): what a
 * payee's link shows. A usable link, or one used within 30 days, answers with the business, the
 * payee, the address and whether it is confirmed, and the payee's payments; any other link answers
 * nothing. Only the service role may call it.
 */

let db: PGlite;
let user: string;
let org: string;

const hash = (n: number) => n.toString(16).padStart(64, "0");

async function payee(name: string, chain = "ARC-TESTNET"): Promise<string> {
  // Only a vendor is paid on another chain (0044).
  const role = chain === "ARC-TESTNET" ? "contractor" : "vendor";
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, chain) values ($1, $2, $3, $4) returning id", [org, name, role, chain])).rows[0].id;
}

async function link(counterpartyId: string, n: number, expiresAt = "2099-01-01T00:00:00Z"): Promise<string> {
  return (await db.query<{ id: string }>("select id from public.create_payee_link($1, $2, $3, $4, $5::timestamptz)", [org, counterpartyId, hash(n), user, expiresAt])).rows[0].id;
}

type Status = {
  orgName: string;
  payeeName: string;
  chain: string;
  linkState: "open" | "used";
  expiresAt: string;
  usedAt: string | null;
  statusUntil: string;
  address: string | null;
  addressConfirmed: boolean;
  payments: Array<{ kind: string; title: string; amount: number; currency: string; status: string; txRef: string | null; settledAt: string | null; scheduledFor: string | null }>;
};

const status = async (n: number): Promise<Status | null> =>
  (await db.query<{ payee_link_status: Status | null }>("select public.payee_link_status($1)", [hash(n)])).rows[0].payee_link_status;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "owner@acme.test");
  org = await createOrg(db, "acme");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("payee_link_status (0053)", () => {
  it("answers a usable link with the business, the payee and what they are owed", async () => {
    const linh = await payee("Linh Tran");
    await db.query(
      `insert into public.milestones (org_id, contractor_id, title, amount, verified, status) values ($1, $2, '10 social posts', 25, true, 'verified')`,
      [org, linh]
    );
    await link(linh, 1);
    expect(await status(1)).toMatchObject({
      orgName: "acme",
      payeeName: "Linh Tran",
      chain: "ARC-TESTNET",
      linkState: "open",
      usedAt: null,
      address: null,
      addressConfirmed: false,
      payments: [{ kind: "milestone", title: "10 social posts", amount: 25, currency: "USDC", status: "verified", txRef: null, settledAt: null }],
    });
  });

  it("keeps answering for 30 days after the link was used, with the address and whether a person confirmed it", async () => {
    const minh = await payee("Minh Le");
    await link(minh, 2);
    await db.query("update public.payee_links set used_at = now() - interval '29 days' where token_hash = $1", [hash(2)]);
    await db.query("update public.counterparties set address = $2, address_changed_at = now() - interval '1 day' where id = $1", [minh, `0x${"ab".repeat(20)}`]);
    expect(await status(2)).toMatchObject({ linkState: "used", address: `0x${"ab".repeat(20)}`, addressConfirmed: false });

    await db.query("update public.counterparties set address_confirmed_at = now() where id = $1", [minh]);
    expect((await status(2))?.addressConfirmed).toBe(true);

    await db.query("update public.payee_links set used_at = now() - interval '31 days' where token_hash = $1", [hash(2)]);
    expect(await status(2)).toBeNull();
  });

  it("counts an address set when the payee was added, never changed, as confirmed", async () => {
    const set = await payee("Already Set");
    await db.query("update public.counterparties set address = $2 where id = $1", [set, `0x${"cd".repeat(20)}`]);
    await link(set, 3);
    expect((await status(3))?.addressConfirmed).toBe(true);
  });

  it("answers nothing for a revoked, expired or unknown link", async () => {
    const gone = await payee("Gone");
    await link(gone, 4);
    await link(gone, 5); // revokes link 4, unused
    expect(await status(4)).toBeNull();
    await link(gone, 6, "2020-01-01T00:00:00Z");
    expect(await status(6)).toBeNull();
    expect(await status(999)).toBeNull();
  });

  it("lists open payments and those paid since the link was made, never rejected or older paid ones, newest ten", async () => {
    const vendor = await payee("Northwind", "BASE-SEPOLIA");
    // Each invoice is created a millisecond after the one before, so the order the listing reads is never a tie,
    // however fast two inserts run.
    let tick = 0;
    const add = (memo: string, status: string, extra = "") => {
      tick += 1;
      return db.query(
        `insert into public.invoices (org_id, counterparty_id, direction, amount, currency, memo, due_date, status, created_at${extra ? ", settled_at, tx_ref" : ""})
         values ($1, $2, 'payable', 10, 'USDC', $3, now() + interval '5 days', $4, clock_timestamp() + make_interval(secs => $5::int / 1000.0)${extra})`,
        [org, vendor, memo, status, tick]
      );
    };
    await add("Paid last year", "paid", ", now() - interval '400 days', '0xold'");
    await add("Rejected", "rejected");
    await link(vendor, 7);
    await add("Held one", "held");
    await add("Paid today", "paid", ", now(), '0xnew'");
    await db.query(
      `insert into public.invoices (org_id, counterparty_id, direction, amount, currency, memo, due_date, status) values ($1, $2, 'receivable', 5, 'USDC', 'Owed to us', now(), 'pending')`,
      [org, vendor]
    );
    const found = await status(7);
    expect(found?.chain).toBe("BASE-SEPOLIA");
    expect(found?.payments.map((p) => [p.title, p.status, p.txRef])).toEqual([
      ["Held one", "held", null],
      ["Paid today", "paid", "0xnew"],
    ]);

    for (let i = 0; i < 12; i += 1) await add(`Open ${i}`, "pending");
    expect((await status(7))?.payments).toHaveLength(10);
  });

  it("is the service role's alone", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.payee_link_status($1)", [hash(1)]))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, org, (tx) => tx.query("select public.payee_link_status($1)", [hash(1)]))).rejects.toThrow(/permission denied/);
  });
});
