import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No new copy that names Arc testnet whatever the workspace's network (docs/superpowers/specs/2026-10-06-mainnet-copy-
 * design.md C10). A workspace's messages and pages name its network from its profile's `label`. The files below keep
 * testnet words because they are true wherever they show, each with how many and why, so a new one anywhere fails here,
 * and one more in a listed file fails too. Comments are not counted, as network foundation N8's ratchet does not count
 * them. "Faucet" counts as copy only as Circle's faucet or its address: the profile's `faucet` field is not copy.
 */

const ROOT = process.cwd();
const COPY = /Arc testnet|testnet USDC|Circle(?:'|&apos;)s faucet|faucet\.circle\.com/gi;
const PROFILE = "src/lib/network.ts";

const ALLOWED: Record<string, number> = {
  // The platform's own pages, which describe it as it runs in production (C5): the social preview, the landing page and
  // its sections, the footer of the landing page and the compact footer's default for platform pages (C6), the docs
  // site's navigation, the network picker that names both networks, and /open, which counts each network apart.
  "src/app/_og/SocialPreview.tsx": 1,
  "src/app/page.tsx": 3,
  "src/components/landing/Credentials.tsx": 1,
  "src/components/landing/FinalCta.tsx": 4,
  "src/components/landing/Hero.tsx": 5,
  "src/components/landing/HowItWorks.tsx": 2,
  "src/components/landing/LiveProof.tsx": 1,
  "src/components/landing/hero/scenarios.ts": 1,
  "src/components/vx/SiteChrome.tsx": 2,
  "src/lib/docs/nav.ts": 5,
  "src/components/CreateWorkspaceForm.tsx": 1,
  "src/app/open/page.tsx": 4,
  // Terms and privacy: the partner rewrites them before a deployment switches Arc mainnet on (C5).
  "src/app/terms/page.tsx": 8,
  "src/app/privacy/page.tsx": 3,
  // Demo data, which exists on Arc testnet: the design page's fixtures, and the research replay's default for decisions
  // recorded before payouts were.
  "src/app/design/fixtures.ts": 1,
  "src/lib/research/replay.ts": 1,
  // Milestone escrow, only on Arc testnet (`escrow`); Contractors draws it only there (C3).
  "src/app/actions/escrow.ts": 1,
  "src/app/o/[slug]/contractors/page.tsx": 2,
  "src/components/EscrowPanel.tsx": 1,
  "src/components/MilestoneEscrow.tsx": 1,
  "src/lib/circle/escrow-holds.ts": 2,
  "src/lib/payments.ts": 1,
  // The USYC reserve and Gateway, only on Arc testnet (`usyc`, `gateway`); Settings and the console draw them only there.
  "src/app/actions/treasury.ts": 5,
  "src/components/UsycReservePanel.tsx": 5,
  "src/lib/platform/usyc-reserve.ts": 1,
  "src/lib/agent/liquidity.ts": 1,
  // Shadow mode, only on Arc testnet (shadow mode S1): its Settings panel and the refusal it shows on Arc mainnet, the
  // console's summary and the verdict's Agree and pay, both shown only while a workspace is in it.
  "src/components/ShadowModePanel.tsx": 2,
  "src/components/ShadowModeSummary.tsx": 1,
  "src/components/VerdictControl.tsx": 1,
  "src/lib/shadow-mode.ts": 1,
  // A mirror address, made only in shadow mode: its control and the page's line saying which address is one, the library's
  // refusal before going live and its ledger summary.
  "src/components/MirrorAddressControl.tsx": 1,
  "src/app/o/[slug]/counterparties/page.tsx": 1,
  "src/lib/mirror-address.ts": 2,
  // Passkey wallets, offered only to a payee on Arc testnet (`modularWallets`).
  "src/components/payee/PasskeyWalletOption.tsx": 1,
  "src/components/wallet/PasskeyWallet.tsx": 1,
  // CCTP, Gateway, the spending-limit contract and the USDC/EURC swap, only on Arc testnet: their refusals and reasons, and
  // the receipt's CCTP route and burn. The live provider's faucet clause is its branch for a network with a faucet.
  "src/lib/circle/liveProvider.ts": 6,
  "src/lib/circle/simulateProvider.ts": 1,
  "src/lib/agent/orchestrator.ts": 1,
  "src/lib/spending-limit/onchain.ts": 3,
  "src/lib/fx/errors.ts": 1,
  "src/lib/fx/swap-service.ts": 1,
  "src/lib/fx/swap.ts": 1,
  "src/components/receipt/ReceiptView.tsx": 2,
  // Branches that run only on a network with a faucet or hosted wallets (C2): the Go live panel's hosted-wallet and
  // faucet steps and its Arc testnet status line, getting-started's faucet step, and the EURC guardrail's faucet clause.
  "src/components/GoLivePanel.tsx": 11,
  "src/lib/getting-started.ts": 4,
  "src/lib/agent/guardrails.ts": 1,
  // Text that names both networks, or is true on either: the API's description of each network's chain, the key check's
  // message for an Arc testnet workspace given a live key, sample data's "runs on Arc testnet only", and the payee form's
  // default label, which the payee page replaces with its chain's.
  "src/lib/api/schemas.ts": 1,
  "src/lib/platform/go-live.ts": 1,
  "src/lib/sample-data.ts": 1,
  "src/components/PayeeAddressForm.tsx": 1,
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** The source without its comments: block comments, and line comments not inside a URL or a string's quotes. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function copyIn(source: string): number {
  return code(source).match(COPY)?.length ?? 0;
}

describe("testnet words in copy (mainnet copy C10)", () => {
  it("appear only in files where they are true wherever they show, no more often", () => {
    const counts: Record<string, number> = {};
    for (const file of walk(path.join(ROOT, "src")).filter((name) => /\.(ts|tsx)$/.test(name))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === PROFILE) continue;
      const found = copyIn(readFileSync(file, "utf8"));
      if (found > 0) counts[rel] = found;
    }
    expect(counts, "a workspace's copy names its network from its profile; a count that went down is written down here").toEqual(ALLOWED);
  });

  it("counts copy in code, and not in a comment or the profile's faucet field", () => {
    expect(copyIn('// paid on Arc testnet\nconst a = "paid on Arc testnet";')).toBe(1);
    expect(copyIn("/* Circle's faucet */ const b = `Send testnet USDC from Circle's faucet`;")).toBe(2);
    expect(copyIn("const c = profile.faucet ? 1 : 0; const d = { faucet: true };")).toBe(0);
    expect(copyIn("<a>faucet.circle.com</a> Circle&apos;s faucet")).toBe(2);
  });
});
