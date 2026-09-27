/**
 * Connectivity and reconciliation check for the Circle stack.
 *
 *   npm run circle:doctor -- <org-slug>
 *
 * Verifies the API key is accepted and the entity secret is registered (the
 * most common setup failure), then lists every provisioned wallet with its
 * real on-chain balance next to what the named organization's records
 * believe — a drift between the two is the thing most worth catching early in
 * a treasury app.
 *
 * It checks the organization's own Circle credentials, stored encrypted on
 * the organization and opened inside its scope (for the founding
 * organization, `npm run org:adopt-env` puts them there) — the credentials
 * its payments actually use, not this environment's CIRCLE_API_KEY and
 * CIRCLE_ENTITY_SECRET.
 */
import { config } from "dotenv";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { circleCredentialsFrom } from "./lib/circle-credentials";
import { orgSlugFromArgv } from "./lib/org-arg";

config({ path: [".env.local", ".env"], quiet: true });

type ApiError = { response?: { data?: unknown }; message?: string };
const explain = (e: unknown) =>
  JSON.stringify((e as ApiError)?.response?.data ?? (e as ApiError)?.message ?? e);

const fmt = (n: number) => n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

async function main() {
  const slug = orgSlugFromArgv(process.argv.slice(2), "npm run circle:doctor -- <org-slug>");
  const { withOrgSlug } = await import("../src/lib/dal/scope");
  await withOrgSlug(slug, async () => {
    const { currentOrgConfig } = await import("../src/lib/context");
    // Refuses, naming what is missing or why it could not be read, before
    // anything reaches Circle.
    const { apiKey, entitySecret } = circleCredentialsFrom(currentOrgConfig().chain, slug);
    console.log(`Circle credentials: ${slug}'s own, stored on the organization`);

    const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

    try {
      await client.getPublicKey();
      console.log("\n[ok] API key accepted and entity secret registered.");
    } catch (e) {
      console.log(`\n[fail] getPublicKey: ${explain(e)}`);
      process.exit(1);
    }

    // Name every provisioned address from the database so the listing below is
    // readable instead of a wall of hex.
    const names = new Map<string, string>();
    const stored = new Map<string, number>();
    try {
      const { db } = await import("../src/lib/dal");
      const orgDb = db();
      const accounts =
        ((await orgDb.from("accounts").select("name, address, balance")).data as Array<{
          name: string;
          address: string | null;
          balance: string;
        }>) ?? [];
      const counterparties =
        ((await orgDb.from("counterparties").select("name, address")).data as Array<{
          name: string;
          address: string | null;
        }>) ?? [];

      for (const a of accounts) {
        if (!a.address) continue;
        names.set(a.address.toLowerCase(), a.name);
        stored.set(a.address.toLowerCase(), Number(a.balance));
      }
      for (const c of counterparties) {
        if (c.address) names.set(c.address.toLowerCase(), c.name);
      }
    } catch (e) {
      console.log(`\n[warn] could not read Supabase for wallet names: ${explain(e)}`);
    }

    for (const chain of ["ARC-TESTNET", "BASE-SEPOLIA"] as const) {
      let wallets;
      try {
        wallets = (await client.listWallets({ blockchain: chain })).data?.wallets ?? [];
      } catch (e) {
        console.log(`\n[fail] listWallets(${chain}): ${explain(e)}`);
        continue;
      }

      console.log(`\n${chain} — ${wallets.length} wallet(s)`);
      for (const wallet of wallets) {
        const address = (wallet.address ?? "").toLowerCase();
        const label = names.get(address) ?? "(not in this organization)";

        let onChain = 0;
        const tokenIds = new Set<string>();
        try {
          const balances =
            (await client.getWalletTokenBalance({ id: wallet.id })).data?.tokenBalances ?? [];
          for (const b of balances) {
            if (b.token?.symbol !== "USDC") continue;
            // Arc testnet exposes more than one token record for USDC; the
            // balances mirror each other, so summing would double-count.
            if (b.token?.id) tokenIds.add(b.token.id);
            onChain = Math.max(onChain, Number(b.amount ?? 0));
          }
        } catch {
          // A wallet with no balance history can 404; treat that as zero.
        }

        const believed = stored.get(address);
        const drift =
          believed === undefined ? "" : Math.abs(believed - onChain) < 0.000001
            ? "  in sync"
            : `  DB says ${fmt(believed)} — drift ${fmt(believed - onChain)}`;

        console.log(
          `  ${label.padEnd(34)} ${fmt(onChain).padStart(10)} USDC  ${wallet.address}${drift}`
        );
        if (tokenIds.size > 1) {
          console.log(`      note: ${tokenIds.size} USDC token ids on this chain`);
        }
      }
    }

    console.log(
      "\nDrift is expected on the operating wallet when the USYC leg is simulated:\n" +
        "the reserve is a notional carve-out of USDC that physically stays put."
    );
  });
}

main().catch((e) => {
  console.error(explain(e));
  process.exit(1);
});
