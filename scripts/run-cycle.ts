/**
 * Runs one agent cycle from the command line — the same code path the
 * dashboard button triggers. This is what you point a cron job or a GitHub
 * Action at to let the agent run unattended.
 *
 *   npm run cycle -- <org-slug>
 */
import { config } from "dotenv";
import { orgSlugFromArgv } from "./lib/org-arg";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { withOrgSlug } = await import("../src/lib/dal/scope");
  await withOrgSlug(orgSlugFromArgv(process.argv.slice(2), "npm run cycle -- <org-slug>"), async () => {
    const { runAgentCycle } = await import("../src/lib/agent/orchestrator");
    const started = Date.now();
    const result = await runAgentCycle();

    const clock = result.clockMode === "simulate" ? `day ${result.day}` : `wall clock ${result.finishedAt}`;
    console.log(`${clock} · payments ${result.mode} · ${Date.now() - started}ms\n`);
    for (const line of result.lines) {
      console.log(`  [${line.domain}] ${line.message}`);
    }
    if (result.lines.length === 0) console.log("  (nothing to decide)");
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
