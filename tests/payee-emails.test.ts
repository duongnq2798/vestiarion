import { describe, expect, it } from "vitest";
import { payeeAddressEmail } from "@/lib/email/payee-address";
import { payeeLinkEmail } from "@/lib/email/payee-link";

/**
 * The two emails of paying a freelancer in one step
 * (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md §2): the link
 * the freelancer opens to add an address, and the note asking the workspace's
 * approvers to confirm it. Every value from a person is escaped, and every
 * link points at the site.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const LINK = `${ORIGIN}/payee/vxp_${"a".repeat(43)}`;

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
const srcs = (html: string) => [...html.matchAll(/src="([^"]*)"/g)].map((match) => match[1]);

describe("payeeLinkEmail", () => {
  const email = payeeLinkEmail({
    orgName: "Mai's <Studio>",
    payeeName: "Linh",
    work: "10 Canva posts & 2 reels",
    amount: "12.5",
    link: LINK,
    expiresAt: new Date("2026-10-08T15:00:00Z"),
    origin: ORIGIN,
    network: "arc-testnet",
  });

  it("says who is paying, how much and for what", () => {
    expect(email.subject).toBe("Mai's <Studio> wants to pay you 12.5 USDC");
    expect(email.text).toContain("Mai's <Studio> wants to pay you 12.5 USDC on Arc testnet for: 10 Canva posts & 2 reels.");
  });

  it("names the workspace's network: Arc mainnet for a workspace there (mainnet copy C1)", () => {
    const mainnet = payeeLinkEmail({ orgName: "Acme", payeeName: "Linh", work: "Posts", amount: "12.5", link: LINK, expiresAt: new Date("2026-10-08T15:00:00Z"), origin: ORIGIN, network: "arc-mainnet" });
    for (const part of [mainnet.text, mainnet.html]) {
      expect(part).toContain("on Arc mainnet for:");
      expect(part).not.toContain("Arc testnet");
    }
  });

  it("links the one-time page to add an address, and says when it expires", () => {
    expect(hrefs(email.html)).toContain(LINK);
    expect(email.text).toContain(LINK);
    expect(email.text).toContain("2026-10-08");
    expect(email.text).toContain("takes your address once");
  });

  it("says the same link shows the payment's status afterwards (freelancer journey R1)", () => {
    expect(email.text).toContain("After that, the same link shows your payment's status, step by step, for 30 days.");
  });

  it("escapes every value a person typed", () => {
    expect(email.html).toContain("Mai&#39;s &lt;Studio&gt;");
    expect(email.html).toContain("10 Canva posts &amp; 2 reels");
    expect(email.html).not.toContain("<Studio>");
  });

  it("links and loads nothing from another host", () => {
    for (const url of [...hrefs(email.html), ...srcs(email.html)]) expect(url.startsWith(`${ORIGIN}/`), url).toBe(true);
  });
});

describe("payeeAddressEmail", () => {
  const email = payeeAddressEmail({
    orgName: "Mai's Studio",
    payeeName: "Linh <3",
    address: "0x1111111111111111111111111111111111111111",
    link: `${ORIGIN}/o/mai/counterparties`,
    origin: ORIGIN,
  });

  it("asks an approver to check and confirm the address before anything is paid", () => {
    expect(email.subject).toBe("Linh <3 added an address to be paid at");
    expect(email.text).toContain("0x1111111111111111111111111111111111111111");
    expect(email.text).toContain("Nothing is paid to it until someone confirms it");
    expect(hrefs(email.html)).toContain(`${ORIGIN}/o/mai/counterparties`);
  });

  it("escapes the payee's name", () => {
    expect(email.html).toContain("Linh &lt;3");
    expect(email.html).not.toContain("Linh <3");
  });
});
