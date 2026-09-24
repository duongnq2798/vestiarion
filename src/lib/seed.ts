import { supabase, unwrap } from "./supabase";
import { appendLedgerEntry } from "./ledger";

/**
 * Demo business: Northstar Studio, a four-person dev shop. The fixtures are
 * chosen so that a single agent cycle exercises every branch worth showing:
 * a clean three-way match (pays), a missing-PO invoice (asks for
 * information), an over-limit invoice (holds), a watchlisted counterparty
 * (flags), two verified milestones (releases same-day), and enough idle cash
 * to trigger a treasury sweep.
 *
 * Replace these rows with real ones and nothing about the agent changes —
 * see "Bringing your own business" in README.md.
 */

function daysFromNow(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

/**
 * Amounts are written at the scale a real dev shop would invoice at, then
 * multiplied by this factor. In live mode that matters: Circle's public
 * faucet gives 20 testnet USDC every two hours, so a cycle denominated in
 * thousands would simply fail to settle. Scaling down means every payment in
 * the demo is a real on-chain transfer rather than an insufficient-funds
 * error, which is the whole point of running against Arc at all.
 */
export function seedScale(): number {
  const override = process.env.SEED_SCALE;
  if (override) return Number(override);
  const live = !!process.env.CIRCLE_API_KEY && !!process.env.CIRCLE_ENTITY_SECRET;
  return live ? 0.001 : 1;
}

const TABLES = [
  "ledger_entries",
  "forecasts",
  "compliance_checks",
  "treasury_actions",
  "payment_intents",
  "milestones",
  "invoices",
  "counterparties",
  "accounts",
] as const;

/**
 * Wallet provisioning survives a reset. Rows are keyed by name, which is
 * stable across an explicit CLI re-seed, so running the demo-only command in live mode
 * restores the demo without stranding the Arc wallets that `bootstrap:circle`
 * created — or silently minting nine more.
 */
interface Provisioning {
  accounts: Map<string, { circle_wallet_id: string | null; address: string | null }>;
  counterparties: Map<string, string | null>;
}

async function captureProvisioning(): Promise<Provisioning> {
  const db = supabase();
  const accounts = (
    (await db.from("accounts").select("name, circle_wallet_id, address")).data ?? []
  ) as Array<{ name: string; circle_wallet_id: string | null; address: string | null }>;
  const counterparties = (
    (await db.from("counterparties").select("name, address")).data ?? []
  ) as Array<{ name: string; address: string | null }>;

  return {
    accounts: new Map(
      accounts.map((a) => [a.name, { circle_wallet_id: a.circle_wallet_id, address: a.address }])
    ),
    counterparties: new Map(counterparties.map((c) => [c.name, c.address])),
  };
}

async function restoreProvisioning(saved: Provisioning) {
  const db = supabase();

  for (const [name, wallet] of saved.accounts) {
    if (!wallet.circle_wallet_id && !wallet.address) continue;
    const res = await db
      .from("accounts")
      .update({ circle_wallet_id: wallet.circle_wallet_id, address: wallet.address })
      .eq("name", name);
    if (res.error) throw new Error(res.error.message);
  }

  for (const [name, address] of saved.counterparties) {
    if (!address) continue;
    const res = await db.from("counterparties").update({ address }).eq("name", name);
    if (res.error) throw new Error(res.error.message);
  }
}

export async function resetDatabase() {
  const db = supabase();
  for (const table of TABLES) {
    // PostgREST requires a filter on delete; this one matches every row.
    const res = await db.from(table).delete().not("id", "is", null);
    if (res.error) throw new Error(`clearing ${table}: ${res.error.message}`);
  }
  const clock = await db.from("sim_clock").update({ current_day: 0 }).eq("id", 1);
  if (clock.error) throw new Error(clock.error.message);
}

export async function seedDatabase() {
  const db = supabase();
  const scale = seedScale();
  const amt = (value: number) => Number((value * scale).toFixed(6));

  const provisioning = await captureProvisioning();
  await resetDatabase();

  const accounts = unwrap(
    await db
      .from("accounts")
      .insert([
        {
          name: "Arc Operating Wallet",
          kind: "operating",
          chain: "ARC-TESTNET",
          token: "USDC",
          balance: amt(18500),
          apy: 0,
        },
        {
          name: "USYC Reserve",
          kind: "reserve",
          chain: "ARC-TESTNET",
          token: "USYC",
          balance: 0,
          apy: 0.045,
        },
        {
          name: "Base Client Wallet",
          kind: "chain",
          chain: "BASE-SEPOLIA",
          token: "USDC",
          balance: amt(6200),
          apy: 0,
        },
      ])
      .select("id, name")
  ) as Array<{ id: string; name: string }>;

  const counterparties = unwrap(
    await db
      .from("counterparties")
      .insert([
        { name: "Vercel Inc", role: "vendor", chain: "ARC-TESTNET", payment_limit: amt(2000), baseline_payment_limit: amt(2000) },
        { name: "Anthropic API Services", role: "vendor", chain: "ARC-TESTNET", payment_limit: amt(5000), baseline_payment_limit: amt(5000) },
        { name: "Zenith Trading LLC", role: "vendor", chain: "ARC-TESTNET", payment_limit: amt(3000), baseline_payment_limit: amt(3000) },
        // On the watchlist at the medium tier, which is the tier worth
        // demonstrating: it is not a block, it is a reduced limit. The
        // 900 USDC invoice below would clear a 2000 limit and does not clear
        // the 500 the screening leaves behind.
        { name: "Wardrobe Holdings Ltd", role: "vendor", chain: "ARC-TESTNET", payment_limit: amt(2000), baseline_payment_limit: amt(2000) },
        { name: "Lumen Retail Co", role: "client", chain: "ARC-TESTNET", payment_limit: null, baseline_payment_limit: null },
        { name: "Priya Shah — Backend Contractor", role: "contractor", chain: "ARC-TESTNET", payment_limit: amt(4000), baseline_payment_limit: amt(4000) },
        { name: "Diego Ramirez — Design Contractor", role: "contractor", chain: "ARC-TESTNET", payment_limit: amt(2500), baseline_payment_limit: amt(2500) },
      ])
      .select("id, name")
  ) as Array<{ id: string; name: string }>;

  const cp = (fragment: string) => {
    const match = counterparties.find((c) => c.name.includes(fragment));
    if (!match) throw new Error(`seed: no counterparty matching "${fragment}"`);
    return match.id;
  };

  const invoices = await db.from("invoices").insert([
    {
      direction: "payable",
      counterparty_id: cp("Vercel"),
      amount: amt(240),
      memo: "Hosting — September",
      po_reference: "PO-1042",
      goods_received: true,
      due_date: daysFromNow(3),
    },
    {
      direction: "payable",
      counterparty_id: cp("Vercel"),
      amount: amt(95),
      memo: "Bandwidth overage",
      po_reference: null,
      goods_received: false,
      due_date: daysFromNow(4),
    },
    {
      direction: "payable",
      counterparty_id: cp("Anthropic"),
      amount: amt(1800),
      memo: "API usage — September",
      po_reference: "PO-1043",
      goods_received: true,
      due_date: daysFromNow(1),
    },
    {
      direction: "payable",
      counterparty_id: cp("Anthropic"),
      amount: amt(6200),
      memo: "Enterprise tier upgrade",
      po_reference: "PO-1050",
      goods_received: true,
      due_date: daysFromNow(7),
    },
    {
      direction: "payable",
      counterparty_id: cp("Zenith"),
      amount: amt(2600),
      memo: "Consulting services",
      po_reference: null,
      goods_received: false,
      due_date: daysFromNow(5),
    },
    {
      // A complete three-way match from a counterparty that would be paid
      // without hesitation — except that screening tiered its limit to 500.
      // Nothing about this invoice is wrong; the counterparty is what changed.
      direction: "payable",
      counterparty_id: cp("Wardrobe"),
      amount: amt(900),
      memo: "Office fit-out — final instalment",
      po_reference: "PO-1061",
      goods_received: true,
      due_date: daysFromNow(6),
    },
    {
      direction: "receivable",
      counterparty_id: cp("Lumen"),
      amount: amt(9000),
      memo: "Q3 platform retainer",
      po_reference: "SO-771",
      goods_received: true,
      due_date: daysFromNow(10),
    },
  ]);
  if (invoices.error) throw new Error(invoices.error.message);

  const milestones = await db.from("milestones").insert([
    {
      contractor_id: cp("Priya"),
      title: "API rate-limiting module shipped",
      amount: amt(1200),
      verification_source: "deliverable:github-pr#482",
      verified: true,
      status: "verified",
    },
    {
      contractor_id: cp("Diego"),
      title: "Landing page redesign — milestone 2",
      amount: amt(900),
      verification_source: "timesheet:kimai",
      verified: true,
      status: "verified",
    },
    {
      contractor_id: cp("Priya"),
      title: "Sprint 14 backend work",
      amount: amt(1500),
      verification_source: "timesheet:kimai",
      verified: false,
      status: "pending",
    },
  ]);
  if (milestones.error) throw new Error(milestones.error.message);

  await restoreProvisioning(provisioning);

  await appendLedgerEntry({
    actor: "system",
    domain: "system",
    action: "seed",
    summary: "Seeded demo business: Northstar Studio",
    detail: {
      accounts: accounts.length,
      counterparties: counterparties.length,
      invoices: 6,
      milestones: 3,
      amountScale: scale,
    },
  });

  return { scale };
}
