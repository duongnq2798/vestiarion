import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LatestDecision } from "@/components/landing/LatestDecision";
import { checkSentence } from "@/components/landing/SignatureCheck";
import type { LatestDecisionShown } from "@/lib/platform/latest-decision";

/**
 * The landing's latest decision band (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L2), as the server
 * renders it: what happened and who decided, the transaction, the entry to check, and nothing when there is none.
 */

const TX_URL = `https://explorer.testnet.arc.io/tx/0x${"ab".repeat(32)}`;
const DECISION: LatestDecisionShown = {
  seq: 1899,
  at: "2026-10-08T10:00:00Z",
  ago: "2 h ago",
  network: "Arc testnet",
  headline: "Decided to pay a 0.35 USDC bill.",
  why: "It waits for a person's verdict, in shadow mode.",
  facts: [
    { label: "Proposed by", value: "DeepSeek model", tone: "neutral" },
    { label: "Written policy", value: "Agreed", tone: "proof" },
    { label: "Person", value: "Agreed", tone: "proof" },
  ],
  txUrl: TX_URL,
  link: { body_hash: "b".repeat(64), signature: "s".repeat(128), prev_hash: "p".repeat(64), hash: "h".repeat(64), signing_key_id: "0123456789abcdef" },
  publicKeys: { "0123456789abcdef": "-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----\n" },
};

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("LatestDecision", () => {
  it("says what the agent decided, why, who decided, and when, with the transaction and the entry to check", () => {
    const markup = renderToStaticMarkup(<LatestDecision decision={DECISION} />);
    const words = text(markup);
    for (const part of [
      "The agent's latest decision",
      "2 h ago · Arc testnet",
      "Decided to pay a 0.35 USDC bill.",
      "It waits for a person's verdict, in shadow mode.",
      "Proposed by: DeepSeek model",
      "Written policy: Agreed",
      "Person: Agreed",
      "Ledger entry #1899",
      "Check its signature",
      "Its words, names and reasoning stay in the workspace.",
    ]) {
      expect(words).toContain(part);
    }
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${TX_URL}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`));
    expect(markup).toContain('href="/open"');
    expect(markup).toMatch(/<h2 id="latest-decision-title"/);
  });

  it("renders nothing when there is no decision to show", () => {
    expect(renderToStaticMarkup(<LatestDecision decision={null} />)).toBe("");
  });
});

describe("checkSentence", () => {
  it("says what the check proved, and no more", () => {
    expect(checkSentence({ ok: true }, "0123456789abcdef")).toBe(
      "Verified in your browser: key 0123456789abcdef signed this entry, and it follows the entry before it in the chain."
    );
    expect(checkSentence({ ok: true }, null)).toContain("the workspace's key signed this entry");
  });

  it("tells a failure from a check that could not run here", () => {
    expect(checkSentence({ ok: false, reason: "The entry's chain hash does not match." }, null)).toBe("Did not verify: The entry's chain hash does not match.");
    expect(checkSentence({ ok: null, reason: "The Ed25519 signature could not be checked here." }, null)).toBe(
      "Not checked here: The Ed25519 signature could not be checked here."
    );
  });
});
