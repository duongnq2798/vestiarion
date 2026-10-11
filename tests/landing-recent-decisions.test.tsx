import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LatestPanel } from "@/components/landing/Proof";
import { pastWeekSentence } from "@/components/landing/RecentDecisions";
import { recentDecisionView, type DecisionFacts } from "@/lib/latest-decision";
import type { LatestDecisionShown } from "@/lib/platform/latest-decision";
import type { RecentDecisions } from "@/lib/platform/recent-decisions";

/**
 * The agent's earlier decisions under its latest one, as the server renders the proof
 * (docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md D3-D6): the week's count by network, one row
 * per decision with what came of it in words, the network with real or test money, a transaction link only where one
 * went out, and nothing at all when there is no latest decision or nothing before it.
 */

const NOW = Date.parse("2026-10-11T12:00:00Z");
const TX = `0x${"ab".repeat(32)}`;

const LATEST: LatestDecisionShown = {
  seq: 2599,
  at: "2026-10-11T03:21:36Z",
  ago: "8 h ago",
  network: "Arc mainnet",
  headline: "Paid a 0.12 USDC bill.",
  why: null,
  facts: [{ label: "Code checks", value: "Passed", tone: "proof" }],
  txUrl: `https://explorer.arc.io/tx/${TX}`,
  link: { body_hash: "b".repeat(64), signature: "s".repeat(128), prev_hash: "p".repeat(64), hash: "h".repeat(64), signing_key_id: "0123456789abcdef" },
  publicKeys: { "0123456789abcdef": "-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----\n" },
};

const base: DecisionFacts = {
  seq: 2589,
  ts: "2026-10-11T00:20:07Z",
  action: "ap_pay",
  network: "arc-testnet",
  amount: 0.5,
  currency: "USDC",
  decisionMode: "deepseek",
  agreedWithReference: false,
  guardrailBlocked: true,
  guardrailRule: "bridge.fee_above_cap",
  heldBecause: null,
  resultingStatus: "held",
  txRef: null,
  payOn: null,
  verdict: null,
  paidTxHash: null,
};

const row = (facts: Partial<DecisionFacts>) => recentDecisionView({ ...base, ...facts }, NOW);

const RECENT: RecentDecisions = {
  decisions: [
    // Newer than the latest shown: read a moment later, it never shows beneath it.
    row({ seq: 2601, action: "ap_hold", guardrailBlocked: false, guardrailRule: null }),
    // The latest itself: never twice.
    row({ seq: 2599, network: "arc-mainnet", amount: 0.12, guardrailBlocked: false, guardrailRule: null, resultingStatus: "paid", txRef: TX }),
    row({}),
    row({ seq: 2588, amount: 0.2, agreedWithReference: true, guardrailBlocked: false, guardrailRule: null, resultingStatus: "paid", txRef: TX }),
    row({ seq: 1811, ts: "2026-10-07T09:14:06Z", network: "arc-mainnet", amount: 0.1, agreedWithReference: true, guardrailRule: "counterparty.new_payee" }),
  ],
  pastWeek: { mainnet: 4, testnet: 57 },
};

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the earlier decisions", () => {
  it("list the decisions before the latest one, newest first, never the latest again nor a newer one", () => {
    const markup = renderToStaticMarkup(<LatestPanel latest={LATEST} recent={RECENT} />);
    const list = markup.slice(markup.indexOf("<ol"), markup.indexOf("</ol>"));
    expect(list.match(/<li[\s>]/g) ?? []).toHaveLength(3);
    const words = text(markup);
    expect(words).toContain("Earlier decisions");
    expect(words.indexOf("Decided to pay a 0.50 USDC bill.")).toBeLessThan(words.indexOf("Paid a 0.20 USDC bill."));
    expect(words.indexOf("Paid a 0.20 USDC bill.")).toBeLessThan(words.indexOf("Decided to pay a 0.10 USDC bill."));
    expect(words).not.toContain("Held a 0.50 USDC bill.");
    // The latest decision's sentence shows once, in its own card.
    expect(words.split("Paid a 0.12 USDC bill.")).toHaveLength(2);
  });

  it("say what came of each in words, why, and on which network with real or test money", () => {
    const words = text(renderToStaticMarkup(<LatestPanel latest={LATEST} recent={RECENT} />));
    for (const part of [
      "Refused by code Decided to pay a 0.50 USDC bill. Code refused it: the cross-chain fee was above its cap.",
      "Paid Paid a 0.20 USDC bill. The written policy agreed; code checks passed.",
      "Refused by code Decided to pay a 0.10 USDC bill. Code refused it: a first payment to a new address needs two people.",
      "Arc testnet · test money",
      "Arc mainnet · real money",
    ]) {
      expect(words).toContain(part);
    }
  });

  it("link a transaction only where one went out, on its network's explorer, in a new tab", () => {
    const markup = renderToStaticMarkup(<LatestPanel latest={LATEST} recent={RECENT} />);
    const list = markup.slice(markup.indexOf("<ol"), markup.indexOf("</ol>"));
    const links = list.match(/<a[^>]*href="[^"]*"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain(`href="https://explorer.testnet.arc.io/tx/${TX}"`);
    expect(links[0]).toContain('target="_blank"');
    expect(links[0]).toContain('rel="noopener noreferrer"');
    expect(text(list)).toContain("Transaction on the Arc testnet explorer (opens in a new tab)");
  });

  it("give each time as a machine-readable date with its UTC minute", () => {
    const markup = renderToStaticMarkup(<LatestPanel latest={LATEST} recent={RECENT} />);
    expect(markup).toContain('<time dateTime="2026-10-07T09:14:06Z" title="Oct 7, 2026, 09:14 UTC">4 days ago</time>');
  });

  it("count the week's decisions by network, never added together, and say customers' stay private", () => {
    const words = text(renderToStaticMarkup(<LatestPanel latest={LATEST} recent={RECENT} />));
    expect(words).toContain("In the past 7 days the agent made 4 decisions on Arc mainnet and 57 decisions on Arc testnet in the team's workspaces.");
    expect(words).not.toContain("61");
    expect(words).toContain("Customers' decisions stay private: they are only counted, in the figures below.");
    expect(pastWeekSentence({ mainnet: 0, testnet: 1 })).toBe("In the past 7 days the agent made no decisions on Arc mainnet and 1 decision on Arc testnet in the team's workspaces.");
    expect(pastWeekSentence({ mainnet: 0, testnet: 0 })).toBe("The agent made no decisions in the team's workspaces in the past 7 days.");
  });

  it("end with one way to try it on your own bills and one to how the agent decides, each measured", () => {
    const markup = renderToStaticMarkup(<LatestPanel latest={LATEST} recent={RECENT} />);
    const link = (href: string) => markup.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0] ?? "";
    expect(link("/onboarding\\?shadow=1")).toContain('data-cta="proof-try"');
    expect(link("/how-it-decides")).toContain('data-cta="proof-how-it-decides"');
    expect(markup).toContain('data-cta="proof-signature"');
  });

  it("show nothing beneath the latest decision when there is nothing before it or they could not be read", () => {
    const alone = text(renderToStaticMarkup(<LatestPanel latest={LATEST} />));
    expect(alone).toContain("Paid a 0.12 USDC bill.");
    expect(alone).not.toContain("Earlier decisions");
    expect(text(renderToStaticMarkup(<LatestPanel latest={LATEST} recent={null} />))).not.toContain("Earlier decisions");
    expect(text(renderToStaticMarkup(<LatestPanel latest={LATEST} recent={{ decisions: RECENT.decisions.slice(0, 2), pastWeek: RECENT.pastWeek }} />))).not.toContain(
      "Earlier decisions"
    );
    expect(renderToStaticMarkup(<LatestPanel latest={null} recent={RECENT} />)).toBe("");
  });

  it("never pulse as if it were live: it is read as the page loads", () => {
    expect(renderToStaticMarkup(<LatestPanel latest={LATEST} recent={RECENT} />)).not.toContain("animate-pulse");
  });
});
