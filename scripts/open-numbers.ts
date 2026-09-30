/**
 * Prints the figures the public /open page shows, read the same way
 * (docs/superpowers/specs/2026-09-30-open-numbers-design.md), and keeps the
 * team list that decides which workspaces are ours.
 *
 *   npm run numbers
 *   npm run numbers -- --since 2026-09-27
 *   npm run numbers -- --period 7d
 *   npm run numbers -- team list
 *   npm run numbers -- team add <email>
 *   npm run numbers -- team remove <email>
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const USAGE = "npm run numbers [-- --since YYYY-MM-DD | --period 7d|30d | team list|add <email>|remove <email>]";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error(`${name} needs a value. Usage: ${USAGE}`);
  return value;
}

async function team(argv: string[]) {
  const { listTeam, setTeamMember } = await import("../src/lib/platform/open-numbers");
  const [action, email] = argv;
  if (action === "list") {
    const members = await listTeam();
    if (members.length === 0) console.log("The team list is empty: every workspace with a creator counts as a customer's.");
    for (const member of members) console.log(`${member.email}   since ${member.addedAt}`);
    return;
  }
  if ((action === "add" || action === "remove") && email) {
    const changed = await setTeamMember(email, action === "add");
    console.log(changed ? `${action === "add" ? "Added" : "Removed"} ${email}.` : `${email} was already ${action === "add" ? "on" : "off"} the team.`);
    return;
  }
  throw new Error(`Usage: ${USAGE}`);
}

async function numbers(argv: string[]) {
  const { dailySeries, parsePeriod, readOpenNumbers } = await import("../src/lib/platform/open-numbers");
  const period = parsePeriod({ since: option(argv, "--since"), period: option(argv, "--period") });
  if (period.fallback) throw new Error(`That period could not be read. Usage: ${USAGE}`);
  const numbers = await readOpenNumbers(period);

  console.log(`${period.label} — read ${numbers.generatedAt}\n`);
  const rows = Object.keys(numbers.sides.total) as Array<keyof typeof numbers.sides.total>;
  const table = Object.fromEntries(
    rows.map((row) => [row, { customers: numbers.sides.customers[row], ours: numbers.sides.ours[row], total: numbers.sides.total[row] }])
  );
  console.table(table);

  const series = dailySeries(numbers.daily, period).filter((day) => day.customers + day.ours > 0);
  if (series.length > 0) {
    console.log("\nSettled Arc testnet payments by day (UTC)");
    console.table(Object.fromEntries(series.map((day) => [day.day, { customers: day.customers, ours: day.ours, oursUsdc: day.oursUsdc }])));
  }
  if (numbers.ourPayments.length > 0) {
    console.log("\nOur own workspaces' latest payments");
    for (const payment of numbers.ourPayments) console.log(`${payment.at}   ${payment.amount.toFixed(2)} USDC   ${payment.txHash}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "team") await team(argv.slice(1));
  else await numbers(argv);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
