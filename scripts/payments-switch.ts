/**
 * Switches payments off or on for every workspace, or says which way they are
 * (docs/superpowers/specs/2026-10-05-payment-safety-design.md S7). Every running
 * deployment reads the switch within 10 seconds, with no redeploy.
 *
 *   npm run payments
 *   npm run payments -- off "<reason>"
 *   npm run payments -- on
 *
 * PAYMENTS_DISABLED on the deployment stops payments too; this says so when it is
 * set where the script runs.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const USAGE = 'npm run payments [-- off "<reason>" | on]';

async function main(argv: string[]) {
  const { readPaymentsSwitch, setPaymentsSwitch } = await import("../src/lib/payments-switch");
  const [action, ...rest] = argv;
  if (action === "off") {
    const reason = rest.join(" ").trim();
    if (!reason) throw new Error(`Say why payments are switched off. Usage: ${USAGE}`);
    await setPaymentsSwitch(true, reason);
    console.log(`Payments are switched off for every workspace: ${reason}. Every running deployment stops within 10 seconds.`);
    return;
  }
  if (action === "on") {
    await setPaymentsSwitch(false, null);
    console.log("Payments are back on for every workspace, unless PAYMENTS_DISABLED is set on the deployment.");
    return;
  }
  if (action === undefined) {
    const state = await readPaymentsSwitch();
    console.log(state.off ? `Payments are switched off${state.reason ? `: ${state.reason}` : ""}.` : "Payments are on.");
    return;
  }
  throw new Error(`Usage: ${USAGE}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
