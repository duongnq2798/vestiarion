/**
 * Replaces an organization's business data with the fictional Northstar
 * Studio fixture. Destructive, and for a disposable demo database only.
 *
 *   npm run seed -- <org-slug>
 */
import { config } from "dotenv";
import { orgSlugFromArgv } from "./lib/org-arg";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { withOrgSlug } = await import("../src/lib/dal/scope");
  await withOrgSlug(orgSlugFromArgv(process.argv.slice(2), "npm run seed -- <org-slug>"), async () => {
    const { seedDatabase } = await import("../src/lib/seed");
    const { scale } = await seedDatabase();
    console.log(`Seeded Northstar Studio demo data (amount scale ${scale}).`);
    if (scale !== 1) {
      console.log(
        "Scaled down because Circle live credentials are set, so every payment fits\n" +
          "inside a testnet faucet grant and actually settles. Override with SEED_SCALE."
      );
    }
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
