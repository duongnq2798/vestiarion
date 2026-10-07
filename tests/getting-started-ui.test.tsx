import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { gettingStarted, type GettingStartedInput } from "@/lib/getting-started";

/** The Get started checklist as the markup it renders on the server, and how the console wires it. */

function checklist(overrides: Partial<GettingStartedInput> = {}) {
  return gettingStarted({
    mode: "sandbox",
    accounts: [{ kind: "operating", circle_wallet_id: null, balance: 0 }],
    counterparties: [],
    payableCount: 0,
    onchainPayments: 0,
    waitingCount: 0,
    network: "arc-testnet",
    ...overrides,
  });
}

const render = (props: { isOwner?: boolean } & Partial<GettingStartedInput> = {}) => {
  const { isOwner = true, ...input } = props;
  return renderToStaticMarkup(<GettingStarted slug="acme" checklist={checklist(input)} isOwner={isOwner} />);
};

describe("GettingStarted", () => {
  it("titles the shadow mode checklist as such, and links its guide", () => {
    const markup = render({ shadow: { currency: "USDC", verdictsGiven: 0, billCount: 0 } });
    expect(markup).toContain("Get started in shadow mode");
    expect(markup).toContain('href="/docs/guides/shadow-mode"');
    expect(markup).toContain("Give your first verdict");
  });

  it("lists the six steps, counts the done ones, and links the guide", () => {
    const markup = render({ counterparties: [{ role: "vendor", address: "0x1948aB0000000000000000000000000000c345a0" }] });
    expect(markup).toContain("Get started");
    expect(markup).toContain("1 of 6 done");
    for (const title of ["Add a wallet", "Fund it with USDC", "Go live", "Add a payee with an Arc address", "Add a payable", "First payment on Arc testnet"]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain('href="/docs/guides/go-live"');
    expect(markup).toContain("(done)");
  });

  it("marks and links only the next step", () => {
    const markup = render();
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain('href="/o/acme/settings#go-live-title"');
    expect(markup).toMatch(/>Start<svg[^>]*lucide-arrow-right/);
  });

  it("draws the guide link's icon", () => {
    expect(render()).toMatch(/<svg[^>]*lucide-book-open[^>]*>.*<\/svg>Read the guide/);
  });

  it("links the next step's own page, and the first-payment guide, once the workspace is live and funded", () => {
    const markup = render({ mode: "live", accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 40 }] });
    expect(markup).toContain('href="/o/acme/counterparties"');
    expect(markup).not.toContain('href="/o/acme/settings#go-live-title"');
    expect(markup).toContain('href="/docs/guides/first-payment"');
  });

  it("tells an admin that an owner takes the owner-only steps", () => {
    const markup = render({ isOwner: false });
    expect(markup).toContain("An owner of this workspace does this step.");
    expect(markup).toMatch(/>View<svg/);
  });

  it("renders nothing once the workspace has made its first payment on Arc testnet", () => {
    expect(render({ mode: "live", onchainPayments: 1 })).toBe("");
  });
});

describe("the console's checklist", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

  it("is only computed for people who may add records", () => {
    expect(page).toMatch(/const checklist = can\(role, "records\.write"\)\s*\?\s*gettingStarted\(/);
  });

  it("uses the rows the console already reads, with no extra query, shadow mode's included", () => {
    // Where the treasury lives comes from the workspace's configuration, already in scope (wallet treasury W12).
    expect(page.replace(/\s+/g, " ")).toContain(
      "gettingStarted({ mode: access.membership.mode, accounts: accountsRows, counterparties, payableCount: ownPayableCount(invoices, counterparties), onchainPayments: dashboardStats.onchainTransfers, waitingCount: needsReview, network, walletHost, walletTreasuryAvailable: walletTreasuryAvailable(currentOrgConfig(), networkProfile(network)), shadow: shadow ? { currency: shadow.currency, verdictsGiven: (shadowSummary?.agreed ?? 0) + (shadowSummary?.disagreed ?? 0), billCount: ownBillCount(invoices, counterparties) } : null, })"
    );
  });
});
