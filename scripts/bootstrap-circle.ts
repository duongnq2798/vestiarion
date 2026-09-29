/**
 * One-time setup for live mode. Creates a real Circle developer-controlled
 * wallet on Arc testnet for every treasury account and every counterparty
 * of the named organization that doesn't have one, and writes the ids and
 * addresses back to Supabase.
 *
 *   npm run seed -- <org-slug>
 *   npm run bootstrap:circle -- <org-slug>
 *
 * The wallets are minted with the organization's own Circle credentials,
 * stored encrypted on the organization and opened inside its scope; for the
 * founding organization, `npm run org:adopt-env` puts them there. This
 * environment's CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are never used: they
 * would mint another organization's wallets in the founding organization's
 * Circle entity.
 *
 * The accounts are provisioned by `createTreasuryWallets`
 * (src/lib/circle/provision.ts), the same library an owner's "Create wallets"
 * runs. Counterparties get wallets here only, so the demo is verifiable: when
 * the agent pays Priya, you can watch the USDC land at a real Arc-testnet
 * address. A real deployment would store the address the counterparty gives
 * you instead of minting one on their behalf.
 *
 * Safe to re-run — it skips anything already provisioned.
 */
import { config } from "dotenv";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { circleCredentialsFrom } from "./lib/circle-credentials";
import { orgSlugFromArgv } from "./lib/org-arg";

config({ path: [".env.local", ".env"], quiet: true });

type ApiError = { response?: { data?: unknown }; message?: string };
const explain = (e: unknown) =>
  JSON.stringify((e as ApiError)?.response?.data ?? (e as ApiError)?.message ?? e);

async function main() {
  const slug = orgSlugFromArgv(process.argv.slice(2), "npm run bootstrap:circle -- <org-slug>");
  const { withOrgSlug } = await import("../src/lib/dal/scope");
  await withOrgSlug(slug, async () => {
    const { currentOrgConfig } = await import("../src/lib/context");
    // Checked here as well as in the library, for its messages naming the organization.
    const { apiKey, entitySecret } = circleCredentialsFrom(currentOrgConfig().chain, slug);

    const { db, unwrap } = await import("../src/lib/dal");
    const { createTreasuryWallets, createScaWallet, treasuryWalletSetId } = await import("../src/lib/circle/provision");
    const orgDb = db();

    // ------------------------------------------------------------- accounts
    const accounts = await createTreasuryWallets();
    console.log(`accounts: ${accounts.created} wallet(s) created, ${accounts.skipped} already provisioned`);

    // ------------------------------------------------------- counterparties
    const counterparties = unwrap(
      await orgDb.from("counterparties").select("id, name, chain, address")
    ) as Array<{ id: string; name: string; chain: string | null; address: string | null }>;

    const pending = counterparties.filter((counterparty) => !counterparty.address);
    for (const counterparty of counterparties) {
      if (counterparty.address) console.log(`skip  ${counterparty.name} (already has an address)`);
    }
    if (pending.length > 0) {
      const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
      const walletSetId = await treasuryWalletSetId(client);
      for (const counterparty of pending) {
        const wallet = await createScaWallet(client, walletSetId, counterparty.chain ?? "ARC-TESTNET");
        const res = await orgDb
          .from("counterparties")
          .update({ address: wallet.address })
          .eq("id", counterparty.id);
        if (res.error) throw new Error(res.error.message);
        console.log(`ok    ${counterparty.name} -> ${wallet.address}`);
      }
    }

    const operating = (
      await orgDb.from("accounts").select("address").eq("kind", "operating").limit(1).maybeSingle()
    ).data as { address: string | null } | null;

    console.log("\nNext: fund the operating wallet with testnet USDC.");
    if (operating?.address) {
      console.log(`  Address: ${operating.address}`);
      console.log("  Faucet:  https://faucet.circle.com  (select Arc Testnet, 20 USDC / 2h)");
    }
    console.log(`Then run \`npm run circle:doctor -- ${slug}\` to confirm the balance landed.`);
  });
}

main().catch((e) => {
  console.error(explain(e));
  process.exit(1);
});
