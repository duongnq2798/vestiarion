/**
 * Prints what the system currently looks like: balances, wallet
 * provisioning, open invoices, and ledger height.
 *
 *   npm run status -- <org-slug>
 */
import { config } from "dotenv";
import { orgSlugFromArgv } from "./lib/org-arg";

config({ path: [".env.local", ".env"], quiet: true });

const short = (address: string | null) =>
  address ? `${address.slice(0, 10)}…${address.slice(-4)}` : "— not provisioned";

async function main() {
  const { withOrgSlug } = await import("../src/lib/dal/scope");
  await withOrgSlug(orgSlugFromArgv(process.argv.slice(2), "npm run status -- <org-slug>"), async () => {
    const { db } = await import("../src/lib/dal");
    const client = db();

    const accounts = (await client.from("accounts").select("*").order("kind")).data ?? [];
    const counterparties = (await client.from("counterparties").select("*").order("name")).data ?? [];
    const invoices = (await client.from("invoices").select("status, amount, direction")).data ?? [];
    const milestones = (await client.from("milestones").select("status, amount")).data ?? [];
    const ledger = await client.from("ledger_entries").select("*", { count: "exact", head: true });
    const cycleRuns = await client.from("cycle_runs").select("*", { count: "exact", head: true });
    const cycleSnapshots = await client.from("cycle_snapshots").select("*", { count: "exact", head: true });
    const paymentIntents = await client.from("payment_intents").select("*", { count: "exact", head: true });
    const measuredPayments = await client
      .from("payment_intents")
      .select("*", { count: "exact", head: true })
      .not("executed_at", "is", null);
    // No row yet is day 0: an organization that has never run a simulated
    // cycle has no sim_clock row until its first one.
    const clock = (await client.from("sim_clock").select("current_day").maybeSingle()).data;

    console.log(`day ${(clock as { current_day: number } | null)?.current_day ?? 0}   ledger height ${ledger.count ?? 0}\n`);

    console.log("ACCOUNTS");
    for (const a of accounts as Array<Record<string, string>>) {
      console.log(`  ${a.name.padEnd(22)} ${String(a.balance).padStart(12)} ${a.token.padEnd(5)} ${short(a.address)}`);
    }

    console.log("\nCOUNTERPARTIES");
    for (const c of counterparties as Array<Record<string, string>>) {
      const performance = c.performance_score == null
        ? "no history"
        : `${(Number(c.performance_score) * 100).toFixed(1)}% clean`;
      console.log(
        `  ${c.name.padEnd(34)} ${c.risk_level.padEnd(11)} performance ${performance.padEnd(12)} limit ${String(c.payment_limit ?? "—").padStart(10)}  ${short(c.address)}`
      );
    }

    const byStatus = (rows: Array<{ status: string }>) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});

    console.log("\nINVOICES   ", JSON.stringify(byStatus(invoices as Array<{ status: string }>)));
    console.log("MILESTONES ", JSON.stringify(byStatus(milestones as Array<{ status: string }>)));
    console.log(
      "TELEMETRY  ",
      `${cycleRuns.count ?? 0} cycle runs, ${cycleSnapshots.count ?? 0} snapshots, ` +
        `${measuredPayments.count ?? 0}/${paymentIntents.count ?? 0} payment intents measured`
    );
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
