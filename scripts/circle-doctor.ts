/**
 * Connectivity and reconciliation check for the Circle stack.
 *
 *   npm run circle:doctor
 *
 * Verifies the API key is accepted and the entity secret is registered (the
 * most common setup failure), then lists every provisioned wallet with its
 * real on-chain balance next to what the database believes — a drift between
 * the two is the thing most worth catching early in a treasury app.
 */
import { config } from "dotenv";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

config({ path: [".env.local", ".env"], quiet: true });

type ApiError = { response?: { data?: unknown }; message?: string };
const explain = (e: unknown) =>
  JSON.stringify((e as ApiError)?.response?.data ?? (e as ApiError)?.message ?? e);

const fmt = (n: number) => n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  console.log(`API key:       ${apiKey ? "present" : "MISSING"}`);
  console.log(`Entity secret: ${entitySecret ? "present" : "MISSING"}`);
  if (!apiKey || !entitySecret) process.exit(1);

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
    const { supabase } = await import("../src/lib/supabase");
    const db = supabase();
    const accounts =
      ((await db.from("accounts").select("name, address, balance")).data as Array<{
        name: string;
        address: string | null;
        balance: string;
      }>) ?? [];
    const counterparties =
      ((await db.from("counterparties").select("name, address")).data as Array<{
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
      const label = names.get(address) ?? "(not in this project)";

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
}

main().catch((e) => {
  console.error(explain(e));
  process.exit(1);
});
