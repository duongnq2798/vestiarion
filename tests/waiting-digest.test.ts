import { describe, expect, it } from "vitest";
import { DIGEST_MAX_ITEMS, DIGEST_REASON_MAX, firstSentence, waitingDigestEmail, type DigestItem } from "@/lib/email/waiting-digest";

const origin = "https://www.vestiarion.xyz";
const link = `${origin}/o/acme/approvals`;

function item(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    counterpartyName: "Acme Supplies",
    amount: 1234.5,
    status: "held",
    reason: "The amount exceeds the standing limit.",
    escalated: false,
    ...overrides,
  };
}

describe("firstSentence", () => {
  it("returns null for null", () => {
    expect(firstSentence(null)).toBeNull();
  });

  it("takes the first sentence only", () => {
    expect(firstSentence("Held for review. Will retry later.")).toBe("Held for review.");
  });

  it("drops bracketed guardrail notes before cutting", () => {
    expect(firstSentence("Held for review [guardrail: limit-exceeded].")).toBe("Held for review.");
  });

  it("trims to at most the given max, with an ellipsis", () => {
    const long = `This reasoning goes on for quite a long while ${"x".repeat(200)} and keeps going without a period anywhere near the start`;
    const result = firstSentence(long, 20);
    expect(result).not.toBeNull();
    expect((result as string).length).toBe(20);
    expect(result).toMatch(/…$/);
  });

  it("defaults its max to DIGEST_REASON_MAX", () => {
    const long = "x".repeat(300);
    const result = firstSentence(long);
    expect((result as string).length).toBe(DIGEST_REASON_MAX);
  });

  it("does not cut at a decimal point", () => {
    const reason = "Invoice amount 150.5 USDC exceeds Acme Supplies's payment limit of 100 USDC.";
    expect(firstSentence(reason)).toBe(reason);
  });

  it("does not cut at a decimal point earlier in the sentence", () => {
    const reason = "Invoice amount 1250 USDC exceeds Acme's payment limit of 1000.25 USDC. Held.";
    expect(firstSentence(reason)).toBe("Invoice amount 1250 USDC exceeds Acme's payment limit of 1000.25 USDC.");
  });

  // A sentence ends at a terminator followed by whitespace or the end of the
  // text, so `Corp.` followed by a space still counts as an ending — an
  // abbreviation mid-sentence is still cut short here. Accepted trade-off.
  it("still cuts short at an abbreviation followed by a space", () => {
    expect(firstSentence("Acme Corp. is flagged high risk by compliance screening.")).toBe("Acme Corp.");
  });

  it("returns the whole string when there is no terminator", () => {
    const reason = "Held for review pending more information";
    expect(firstSentence(reason)).toBe(reason);
  });
});

describe("waitingDigestEmail", () => {
  it("uses a singular subject for one item", () => {
    const email = waitingDigestEmail({ orgName: "Acme", items: [item()], link, origin });
    expect(email.subject).toBe("1 payment needs a decision in Acme");
  });

  it("uses a plural subject for more than one item", () => {
    const email = waitingDigestEmail({ orgName: "Acme", items: [item(), item()], link, origin });
    expect(email.subject).toBe("2 payments need a decision in Acme");
  });

  it("lists at most 10 items and says how many more", () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ counterpartyName: `Vendor ${i + 1}` }));
    const email = waitingDigestEmail({ orgName: "Acme", items, link, origin });
    for (let i = 1; i <= DIGEST_MAX_ITEMS; i++) {
      expect(email.html).toContain(`Vendor ${i}`);
      expect(email.text).toContain(`Vendor ${i}`);
    }
    expect(email.html).not.toContain("Vendor 11");
    expect(email.html).not.toContain("Vendor 12");
    expect(email.html).toContain("and 2 more");
    expect(email.text).toContain("and 2 more");
  });

  it("does not say 'and N more' when there are 10 or fewer items", () => {
    const items = Array.from({ length: 10 }, (_, i) => item({ counterpartyName: `Vendor ${i + 1}` }));
    const email = waitingDigestEmail({ orgName: "Acme", items, link, origin });
    expect(email.html).not.toContain("more");
    expect(email.text).not.toContain("more");
  });

  it("escapes a counterparty name in the HTML but not the text", () => {
    const email = waitingDigestEmail({
      orgName: "Acme",
      items: [item({ counterpartyName: `<img src=x onerror="alert(1)">&` })],
      link,
      origin,
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
    expect(email.text).toContain(`<img src=x onerror="alert(1)">&`);
  });

  it("carries the same content in the text part as the HTML", () => {
    const email = waitingDigestEmail({ orgName: "Acme", items: [item({ counterpartyName: "Beta Co", amount: 500 })], link, origin });
    expect(email.text).toContain("Beta Co");
    expect(email.text).toContain("Held");
    expect(email.text).toContain(link);
    expect(email.text).toContain("Acme");
  });

  it("labels each status and marks an escalated item as a reminder", () => {
    const email = waitingDigestEmail({
      orgName: "Acme",
      items: [
        item({ status: "held", escalated: false }),
        item({ status: "flagged", escalated: true }),
        item({ status: "awaiting_info", escalated: false }),
      ],
      link,
      origin,
    });
    expect(email.text).toContain("Held");
    expect(email.text).toContain("Flagged");
    expect(email.text).toContain("Waiting for information");
    expect(email.text).toContain("(reminder)");
    // only the escalated (flagged) item should carry the reminder marker
    const lines = email.text.split("\n").filter((l) => l.includes("(reminder)"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Flagged");
  });

  it("cuts the reason at 140 characters and drops bracketed notes", () => {
    const reason = `Held because the vendor is new [guardrail: new-counterparty]. ${"x".repeat(200)}`;
    const email = waitingDigestEmail({ orgName: "Acme", items: [item({ reason })], link, origin });
    expect(email.html).not.toContain("[guardrail");
    expect(email.text).not.toContain("[guardrail");
    expect(email.text).toContain(firstSentence(reason) as string);
  });

  it("links the button and the plain link to the inbox", () => {
    const email = waitingDigestEmail({ orgName: "Acme", items: [item()], link, origin });
    expect(email.html).toContain(`href="${link}"`);
    expect(email.text).toContain(link);
  });

  it("says why the recipient gets it and how to turn it off", () => {
    const email = waitingDigestEmail({ orgName: "Acme", items: [item()], link, origin });
    const footer = "You get this because you can approve payments in Acme. You can turn these emails off on the Members page.";
    expect(email.html).toContain(footer);
    expect(email.text).toContain(footer);
  });

  it("escapes the org name in the HTML", () => {
    const email = waitingDigestEmail({ orgName: `<b>Acme</b>`, items: [item()], link, origin });
    expect(email.html).not.toContain("<b>Acme</b>");
    expect(email.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
  });

  it("escapes the reason line in the HTML", () => {
    const email = waitingDigestEmail({
      orgName: "Acme",
      items: [item({ reason: "Flagged: <b>suspicious</b> counterparty." })],
      link,
      origin,
    });
    expect(email.html).not.toContain("<b>suspicious</b>");
    expect(email.html).toContain("&lt;b&gt;suspicious&lt;/b&gt;");
    expect(email.text).toContain("Flagged: <b>suspicious</b> counterparty.");
  });
});

describe("a EURC payable in the digest (EURC invoices design E6, review I2)", () => {
  it("is written in EURC, in the HTML and in the text", () => {
    const email = waitingDigestEmail({ orgName: "Acme", link, origin, items: [item({ amount: 100, currency: "EURC" })] });
    expect(email.html).toContain("100.00 EURC");
    expect(email.text).toContain("100.00 EURC");
    expect(email.text).not.toContain("100.00 USDC");
  });

  it("reads each waiting payable's currency", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/notifications/waiting.ts", "utf8");
    expect(source).toContain('.select("id, amount, currency, status, agent_reasoning, notified_at, escalated_at, counterparties(name)")');
  });
});
