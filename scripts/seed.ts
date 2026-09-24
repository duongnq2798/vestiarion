import { config } from "dotenv";
config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { seedDatabase } = await import("../src/lib/seed");
  const { scale } = await seedDatabase();
  console.log(`Seeded Northstar Studio demo data (amount scale ${scale}).`);
  if (scale !== 1) {
    console.log(
      "Scaled down because Circle live credentials are set, so every payment fits\n" +
        "inside a testnet faucet grant and actually settles. Override with SEED_SCALE."
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
