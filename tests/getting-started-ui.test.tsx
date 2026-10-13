import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { gettingStarted, type GettingStartedInput } from "@/lib/getting-started";
import { accountantChecklist, approverChecklist } from "@/lib/onboarding/role-checklists";

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

/** A sandbox with its wallet, not yet funded: the order to a first payment, in one list. */
const WALLET = [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }];

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

  it("lists the steps, counts the done ones, and links the guide", () => {
    const markup = render({ accounts: WALLET, counterparties: [{ role: "vendor", address: "0x1948aB0000000000000000000000000000c345a0" }] });
    expect(markup).toContain("Get started");
    expect(markup).toContain("3 of 8 done");
    for (const title of [
      "Create the workspace",
      "Add a wallet",
      "Fund it with USDC",
      "Go live",
      "Add a payee with an Arc address",
      "Add or import a first bill",
      "Set or confirm the limits",
      "First payment on Arc testnet",
    ]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain('href="/docs/guides/go-live"');
    expect(markup).toContain("(done)");
  });

  it("marks and links only the next step", () => {
    const markup = render({ accounts: WALLET });
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
    const markup = render({ isOwner: false, network: "arc-mainnet" });
    expect(markup).toContain("An owner of this workspace does this step.");
    expect(markup).toMatch(/>View<svg/);
  });

  it("in a sandbox with no wallet, lists the first bill first, then the steps to pay under To pay on Arc, numbered on", () => {
    const markup = render();
    expect(markup).toContain("1 of 9 done");
    const text = markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    expect(text).toMatch(
      /Create the workspace .* Add a supplier .* Add or import a first bill .* See the agent's decision .* Set or confirm the limits .* To pay on Arc .* Add a wallet .* Fund it with USDC .* Go live .* First payment on Arc testnet/
    );
    expect(markup).toMatch(/<h3 id="getting-started-6"[^>]*>To pay on Arc<\/h3><ol start="6" aria-labelledby="getting-started-6">/);
    expect(markup).toContain('href="/o/acme/counterparties?add"');
    expect(markup).toContain('href="/docs/guides/first-payment"');
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it("renders nothing once the workspace has made its first payment on Arc testnet", () => {
    expect(render({ mode: "live", onchainPayments: 1 })).toBe("");
  });
});

describe("the console's checklist", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

  it("computes the owner's only for people who may add records, and an approver's for an approver (onboarding by role R1, R2)", () => {
    expect(page).toMatch(/const ownerChecklist = checklistRole === "owner" && can\(role, "records\.write"\)\s*\?\s*gettingStarted\(/);
    expect(page).toMatch(/checklistRole === "approver" && marks && acts\s*\?\s*approverChecklist\(/);
  });

  it("uses the rows the console already reads, shadow mode's included, with the limits and the dismissal read for the checklist", () => {
    // Where the treasury lives comes from the workspace's configuration, already in scope (wallet treasury W12).
    expect(page.replace(/\s+/g, " ")).toContain(
      "gettingStarted({ mode: access.membership.mode, accounts: accountsRows, counterparties, payableCount: ownPayableCount(invoices, counterparties), billCount: ownBillCount(invoices, counterparties), decidedCount: ownDecidedCount(invoices, counterparties), onchainPayments: dashboardStats.onchainTransfers, waitingCount: needsReview, network, walletHost, walletTreasuryAvailable: walletTreasuryAvailable(currentOrgConfig(), networkProfile(network)), shadow: shadow ? { currency: shadow.currency, verdictsGiven: (shadowSummary?.agreed ?? 0) + (shadowSummary?.disagreed ?? 0), billCount: ownBillCount(invoices, counterparties) } : null, limits: { confirmed: limitsSet || (marks?.limitsConfirmed ?? false), dailyUsdc: budget?.budget?.dailyUsdc ?? null, weeklyUsdc: budget?.budget?.weeklyUsdc ?? null }, dismissed: marks?.mine.has(\"dismissed_owner\") ?? false, })"
    );
  });

  it("offers Don't show again only where the marks can be recorded, and Keep these limits only to who may change them", () => {
    const flat = page.replace(/\s+/g, " ");
    expect(flat).toContain("dismiss={marks?.available ? dismissChecklistAction : undefined}");
    expect(flat).toContain('confirmLimits={marks?.available && can(role, "agent.budget") ? confirmLimitsAction : undefined}');
  });
});

describe("each role's checklist on the page (onboarding by role R1 to R4)", () => {
  const action = async () => {};

  it("offers Don't show again only where it can be recorded, and says it is for good", () => {
    const shown = renderToStaticMarkup(<GettingStarted slug="acme" checklist={checklist()} isOwner dismiss={action} />);
    expect(shown).toContain("Don&#x27;t show again");
    expect(shown).toContain("Hide this checklist for good.");
    expect(shown).toContain('name="role" value="owner"');
    expect(renderToStaticMarkup(<GettingStarted slug="acme" checklist={checklist()} isOwner />)).not.toContain("show again");
  });

  it("offers Keep these limits on the limits step, to who may change them, until they are set or kept", () => {
    const decided = { counterparties: [{ role: "vendor", address: null }], billCount: 1, decidedCount: 1 };
    const open = renderToStaticMarkup(<GettingStarted slug="acme" checklist={checklist({ ...decided, limits: { confirmed: false, dailyUsdc: 50, weeklyUsdc: 150 } })} isOwner confirmLimits={action} />);
    expect(open).toContain("Keep these limits");
    expect(open).toContain('href="/o/acme/console#agent-budget"');
    const kept = renderToStaticMarkup(<GettingStarted slug="acme" checklist={checklist({ ...decided, limits: { confirmed: true, dailyUsdc: 50, weeklyUsdc: 150 } })} isOwner confirmLimits={action} />);
    expect(kept).not.toContain("Keep these limits");
    const viewerLike = renderToStaticMarkup(<GettingStarted slug="acme" checklist={checklist({ ...decided, limits: { confirmed: false, dailyUsdc: 50, weeklyUsdc: 150 } })} isOwner />);
    expect(viewerLike).not.toContain("Keep these limits");
  });

  it("draws an approver's checklist with its own title, guide and dismissal", () => {
    const markup = renderToStaticMarkup(
      <GettingStarted slug="acme" checklist={approverChecklist({ approvalsOpened: true, heldReasonSeen: false, decided: false, waitingCount: 1, firstWaitingId: "b1", dismissed: false })} isOwner={false} dismiss={action} />
    );
    expect(markup).toContain("Get started as an approver");
    expect(markup).toContain("1 of 3 done");
    expect(markup).toContain('href="/docs/guides/first-payment#6-approve-a-held-payment"');
    expect(markup).toContain('href="/o/acme/approvals#payable-b1"');
    expect(markup).toContain('name="role" value="approver"');
    expect(markup).toContain('data-checklist-role="approver"');
  });

  it("draws an accountant's checklist, its steps outside the workspace linked as they are and the hand-off as a download", () => {
    const base = { consoleOpened: true, queueOpened: true, booked: false, applied: true, workspaceSlug: "harbor-bakery", dismissed: false };
    const markup = renderToStaticMarkup(<GettingStarted slug="harbor-bakery" checklist={accountantChecklist({ ...base, handedOff: false })} isOwner={false} />);
    expect(markup).toContain("Get started as an accountant");
    expect(markup).toContain("3 of 4 done");
    expect(markup).toMatch(/<a href="\/api\/accountant\/handoff\?org=harbor-bakery&amp;format=csv" download=""[^>]*>Download<svg/);
    const first = renderToStaticMarkup(<GettingStarted slug="harbor-bakery" checklist={accountantChecklist({ ...base, consoleOpened: false, handedOff: false })} isOwner={false} />);
    expect(first).toContain('href="/accountant"');
  });
});
