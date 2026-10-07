/**
 * Prints a workspace's shadow mode digest (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S8): each decision
 * of the agent's on a real bill since a day, the person's verdict, what it paid with its Arc testnet transaction, and
 * the agreement rate. ASCII with no blank line, ready for `arc-canteen update-traction`. Ask the business before
 * publishing it; --hide-payees names each supplier by a letter.
 *
 *   npm run traction-digest -- <org-slug> --since 2026-10-07
 *   npm run traction-digest -- <org-slug> --since 2026-10-07 --hide-payees
 */
import { config } from "dotenv";
import { orgSlugFromArgv } from "./lib/org-arg";

config({ path: [".env.local", ".env"], quiet: true });

const USAGE = "npm run traction-digest -- <org-slug> --since YYYY-MM-DD [--hide-payees]";

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--since");
  const since = at === -1 ? undefined : argv[at + 1];
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) throw new Error(`Usage: ${USAGE}`);
  // The day goes with --since, so it is never read as the workspace.
  const rest = argv.filter((_, index) => index !== at && index !== at + 1);
  const slug = orgSlugFromArgv(rest, USAGE);

  const { withOrgSlug } = await import("../src/lib/dal/scope");
  const { formatDigest, readDigestFacts } = await import("../src/lib/traction-digest");
  await withOrgSlug(slug, async () => {
    const facts = await readDigestFacts({ slug, since: `${since}T00:00:00Z` });
    console.log(formatDigest(facts, { hidePayees: rest.includes("--hide-payees") }));
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
