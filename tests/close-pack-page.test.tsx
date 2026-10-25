import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClosePackView } from "@/components/ClosePackView";
import type { ClosePack, ClosePackOpenPayment, ClosePackOpenState } from "@/lib/close-pack/types";
import { takeClosePackPageToken } from "@/lib/rate-limit";
import { ADDR_H, ADDR_N, DOC_SHA, samplePack, tx } from "./support/close-pack-fixtures";

vi.mock("server-only", () => ({}));

/**
 * The monthly close pack's page (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP11, CP12, CP16,
 * "Screens and copy"): the figures, each row's facts in the words the CSV uses, what was not settled and the escrow
 * moves, the month controls and downloads, and a print that drops the controls and keeps each row whole. The view is
 * rendered from the made-up October pack; the page itself is read from its source, as the suite renders no page.
 */

const PACK = samplePack();
const render = (pack: ClosePack) => renderToStaticMarkup(<ClosePackView pack={pack} />);
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const MARKUP = render(PACK);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An `<a>` with these attributes, in any order, then this text. */
const anchor = (attributes: Record<string, string>, text = "") =>
  new RegExp(`<a ${Object.entries(attributes).map(([name, value]) => `(?=[^>]*${name}="${escape(value)}")`).join("")}[^>]*>${escape(text)}`);
const TEXT = textOf(MARKUP);

describe("the figures (close pack CP6, CP11)", () => {
  it("counts the month's payments, totals each token, and says how many cited entries verify", () => {
    expect(TEXT).toContain("October 2026");
    expect(TEXT).toContain("Months are calendar months in UTC. A payment counts in the month Circle confirmed it.");
    expect(TEXT).toContain("Payments settled 3");
    expect(TEXT).toContain("Paid 1,650.00 USDC");
    expect(TEXT).toContain("Route fees 0.12 USDC");
    expect(TEXT).toContain("Not settled 1");
    expect(TEXT).toContain("Signed entries verified 12 of 12");
    expect(TEXT).toContain("Network fees are listed with each payment, with where each figure came from. They are not added up: a batch's fee belongs to the whole batch.");
    expect(TEXT).toContain("12 of 12 signed ledger entries this pack cites verified against the workspace's keys.");
  });

  it("names this month so far", () => {
    expect(textOf(render(samplePack({ now: new Date("2026-10-25T09:00:00Z") })))).toContain("October 2026 so far");
  });

  it("keeps each token apart, and says None with nothing paid", () => {
    const eurc = { ...PACK, totals: { ...PACK.totals, onChain: [...PACK.totals.onChain, { token: "EURC" as const, payments: 1, amount: "80.500000", routeFeesUsdc: "0.000000" }] } };
    const text = textOf(render(eurc));
    expect(text).toContain("1,650.00 USDC");
    expect(text).toContain("80.50 EURC");
    expect(text).not.toContain("1,730.50");
    const none = textOf(render({ ...PACK, rows: [], totals: { ...PACK.totals, onChain: [] } }));
    expect(none).toContain("Paid None");
    expect(none).toContain("Route fees None");
  });

  it("lists simulated payments apart, counts shadow-mode ones, and says what it left out or could not read", () => {
    const pack: ClosePack = {
      ...PACK,
      cut: true,
      unread: ["members", "screening"],
      totals: { ...PACK.totals, simulated: [{ token: "USDC", payments: 2, amount: "5.000000", routeFeesUsdc: "0.000000" }], shadow: 2, withoutBill: 3 },
    };
    const text = textOf(render(pack));
    expect(text).toContain("2 simulated payments, 5.00 USDC, listed apart: a sandbox's payments move nothing on chain.");
    expect(text).toContain("2 of these were made in shadow mode: each mirrors a bill the business paid its own way.");
    expect(text).toContain("3 payments whose bill was deleted are not listed. The audit export holds their entries.");
    expect(text).toContain("This month has more than 2,000 payments, so the pack shows the first 2,000. The audit export holds every entry.");
    expect(text).toContain("Members could not be read just now, so people are named by the first 8 characters of their id.");
    expect(text).toContain("Some screening records could not be read just now. Those payments say so.");

    const one = textOf(render({ ...PACK, totals: { ...PACK.totals, simulated: [{ token: "USDC", payments: 1, amount: "1.000000", routeFeesUsdc: "0.000000" }], shadow: 1, withoutBill: 1 } }));
    expect(one).toContain("1 simulated payment, 1.00 USDC, listed apart");
    expect(one).toContain("1 of these was made in shadow mode: it mirrors a bill the business paid its own way.");
    expect(one).toContain("1 payment whose bill was deleted is not listed. The audit export holds its entries.");

    for (const quiet of ["simulated payment", "shadow mode", "whose bill was deleted", "more than 2,000", "could not be read just now"]) expect(TEXT).not.toContain(quiet);
  });
});

describe("a payment's facts (close pack CP7-CP10)", () => {
  it("names the bill, its purchase order, its document and the address paid on its chain", () => {
    expect(TEXT).toContain("Northwind Supplies 100.00 USDC");
    expect(TEXT).toContain("Paid 2026-10-02 14:00 UTC");
    expect(TEXT).toContain("Invoice INV-2041, 100.00 USDC, due 2026-10-15");
    expect(TEXT).toContain("Purchase order PO-77");
    expect(TEXT).toContain(`SHA-256 ${DOC_SHA}; the document itself is not kept.`);
    expect(TEXT).toContain("No document is recorded.");
    expect(TEXT).toContain(`${ADDR_N} on Arc testnet`);
    expect(TEXT).toContain(`${ADDR_H} on Arc testnet`);
  });

  it("says who decided and who approved, an accountant's co-sign first, and who gave and confirmed the address", () => {
    expect(TEXT).toContain("Claude decided to pay it.");
    expect(TEXT).toContain("No person approved it: code checked it and the agent paid it.");
    expect(TEXT).toContain("The agent held it for a person: it is above the figure where two people approve.");
    const cosign = TEXT.indexOf("Co-signed by accountant@firm.test (accountant) on 2026-10-11 10:00 UTC");
    const paid = TEXT.indexOf("Approved and paid by approver@pinecrest.test (approver) on 2026-10-12 11:00 UTC");
    expect(cosign).toBeGreaterThan(-1);
    expect(paid).toBeGreaterThan(cosign);
    expect(TEXT).toContain("Given by owner@pinecrest.test on 2026-10-01 08:00 UTC");
    expect(TEXT).toContain("Confirmed by approver@pinecrest.test on 2026-10-01 09:00 UTC, with Confirm address");
    expect(TEXT).toContain("A second person stood behind it: Yes");
    expect(TEXT).toContain("A second person stood behind it: Not known");
  });

  it("shows each of the six checks with its label in words and its sentence, and its notes under it", () => {
    for (const name of ["Guardrails", "Screening", "OFAC address list", "Payee lock", "Invoice's own address", "Milestone"]) expect(TEXT).toContain(name);
    expect(TEXT).toContain("Checked by code Code checked it before it was sent.");
    expect(TEXT).toContain("✓ Purchase order PO-77 on file and the goods received");
    expect(TEXT).toContain("Verified outside Northwind Supplies was screened clear by OpenSanctions.");
    expect(TEXT).toContain("Inferred Harbor Print was clear as the agent's decision recorded; no screening check is on file.");
    expect(TEXT).toContain("Missing No confirmation of this address is recorded before it was paid.");
    expect(TEXT).toContain("Checked by code The payee lock was on when the address was confirmed, with a 24-hour wait. It was sent 30 hours after the address was given.");
    expect(TEXT).toContain("Does not apply A bill has no milestone to verify.");
    expect(TEXT).toContain("Does not apply The bill's document named no address of its own.");
  });

  it("writes the transaction out in full, links its explorer in a new tab, and names the fees and the burn", () => {
    expect(TEXT).toContain(`Transfer on Arc testnet ${tx("a")}`);
    expect(MARKUP).toMatch(anchor({ href: `https://explorer.testnet.arc.io/tx/${tx("a")}`, target: "_blank", rel: "noreferrer" }, "View on the explorer"));
    expect(TEXT).toContain("View on the explorer (opens in a new tab)");
    expect(TEXT).toContain("Network fee: 0.004 USD, as the chain reported it");
    expect(TEXT).toContain(`Minted on Base Sepolia, through CCTP from Arc testnet ${tx("2")}`);
    expect(TEXT).toContain(`Burn on Arc testnet: ${tx("1")}`);
    expect(MARKUP).toContain(`href="https://sepolia.basescan.org/tx/${tx("2")}"`);
    expect(TEXT).toContain("Route fee: 0.12 USDC");
    expect(TEXT).not.toContain("attempt");
  });

  it("names an earlier attempt, a fee Circle estimated and a simulated payment's fee", () => {
    const [first, ...rest] = PACK.rows;
    const retried = { ...first, transaction: { ...first.transaction, earlierAttempts: 1, networkFeeSource: "provider_estimate" as const } };
    const text = textOf(render({ ...PACK, rows: [retried, ...rest] }));
    expect(text).toContain("Paid on its 2nd attempt");
    expect(text).toContain("Network fee: 0.004 USD, as Circle estimated it");
    const simulated = { ...first, simulated: true, transaction: { ...first.transaction, route: "simulated" as const, txHash: null, explorerUrl: null, simulatedRef: "sim_42", networkFeeUsd: "0.000000", networkFeeSource: "simulated_profile" as const } };
    const sim = textOf(render({ ...PACK, rows: [simulated] }));
    expect(sim).toContain("Simulated: nothing moved on chain (sim_42)");
    expect(sim).toContain("Network fee: 0.00 USD, simulated");
    expect(sim).toContain("Simulated");
  });

  it("names the signed entry and whether it verified, the books, and every entry the row rests on", () => {
    expect(TEXT).toContain("#12 ap_pay, signed with key 1a2b3c4d5e6f7a8b: Verified");
    expect(TEXT).toContain("#23 approval_paid, signed with key 1a2b3c4d5e6f7a8b: Verified");
    expect(TEXT).toContain("Marked paid with this transaction.");
    expect(TEXT).toContain("#2 #3 #10 #12");
    expect(TEXT).toContain("#4 #20 #21 #22 #23");
    const [first, ...rest] = PACK.rows;
    const failed = { ...first, record: { ...first.record!, check: { ok: false as const, reason: "The signature does not match the entry." } } };
    expect(textOf(render({ ...PACK, rows: [failed, ...rest] }))).toContain("#12 ap_pay, signed with key 1a2b3c4d5e6f7a8b: Not verified: The signature does not match the entry.");
  });

  it("links each payment's evidence page, out of the print, and keeps each card whole on a page", () => {
    for (const row of PACK.rows) expect(MARKUP).toContain(`href="${row.evidencePath}"`);
    expect(MARKUP.match(/Open the payment(&#x27;|')s evidence/g)?.length).toBe(4);
    expect(MARKUP).toMatch(anchor({ href: PACK.rows[0].evidencePath }, "Open the payment"));
    expect(MARKUP).toMatch(/<a [^>]*class="[^"]*print:hidden[^"]*"[^>]*>Open the payment/);
    expect(MARKUP.match(/<article [^>]*class="[^"]*break-inside-avoid/g)?.length).toBe(3);
  });

  it("says so when no payment settled in the month, on the workspace's network", () => {
    const text = textOf(render({ ...PACK, rows: [], notSettled: [], escrow: [], totals: { ...PACK.totals, onChain: [] } }));
    expect(text).toContain("No payment settled in October 2026");
    expect(text).toContain("Payments appear here once Circle confirms them on Arc testnet.");
    expect(text).not.toContain("Not settled in October 2026");
    expect(text).not.toContain("Escrow");
  });
});

describe("what was not settled, and the escrow moves (close pack CP3, CP4)", () => {
  it("lists a payment that settled in the next month, apart from the totals", () => {
    expect(TEXT).toContain("Not settled in October 2026");
    expect(TEXT).toContain("Payments sent in the month that Circle did not confirm in it. They are not in the totals.");
    expect(TEXT).toContain("Harbor Print 75.00 USDC");
    expect(TEXT).toContain("Sent on 2026-10-31 22:00 UTC, settled on 2026-11-01 01:00 UTC: it counts in November 2026's pack.");
  });

  it("words every state", () => {
    const base = PACK.notSettled[0];
    const states: Array<[ClosePackOpenState, Partial<ClosePackOpenPayment>, string]> = [
      ["waiting", { sentAt: null }, "Waiting to be sent."],
      ["in_flight", {}, "Sent on 2026-10-31 22:00 UTC, not confirmed yet."],
      ["unknown", {}, "Outcome unknown: Circle did not answer when it was sent, so it may have taken the transfer."],
      ["gateway_failed", {}, "Gateway reported it failed, but it may still be minted on the payee's chain."],
      ["failed", { reason: "FAILED: insufficient funds" }, "The transfer failed (FAILED: insufficient funds). The payee was not paid."],
      ["cancelled", {}, "Circle cancelled the transfer. The payee was not paid."],
      ["not_sent", { reason: "The wallet could not be read" }, "Not sent: it stopped before Circle took the transfer (The wallet could not be read). The payee was not paid."],
      ["refunded", {}, "BlindPay refunded the bank payout, so the USDC came back. The vendor was not paid."],
    ];
    const notSettled = states.map(([state, change], index) => ({ ...base, paymentId: `open-${index}`, state, settledAt: null, ...change }));
    const text = textOf(render({ ...PACK, notSettled }));
    for (const [, , words] of states) expect(text).toContain(words);
  });

  it("lists the month's escrow moves, apart from the totals, with their transaction", () => {
    expect(TEXT).toContain("Escrow");
    expect(TEXT).toContain("Money locked for a milestone, or taken back from escrow, in the month.");
    expect(TEXT).toContain("Locked 500.00 USDC in escrow on 2026-10-06 09:00 UTC");
    expect(MARKUP).toContain(`href="https://explorer.testnet.arc.io/tx/${tx("5")}"`);
  });
});

describe("the controls, downloads and print (close pack CP11, CP12)", () => {
  it("downloads the month's CSV and signed JSON for its workspace, and prints", () => {
    expect(MARKUP).toContain('href="/api/evidence/close-pack?org=pinecrest-studio&amp;month=2026-10&amp;format=csv"');
    expect(MARKUP).toContain('href="/api/evidence/close-pack?org=pinecrest-studio&amp;month=2026-10&amp;format=json"');
    expect(TEXT).toContain("Download CSV");
    expect(TEXT).toContain("Download signed JSON");
    expect(TEXT).toContain("Print or save as PDF");
    expect(TEXT).toContain("Vestiarion records each download in the workspace's ledger with the file's SHA-256, so a copy can be matched to it later.");
  });

  it("chooses a month with the Month field, last month, this month so far, or the months either side", () => {
    expect(MARKUP).toMatch(/<form[^>]*method="get"/);
    expect(MARKUP).toMatch(/<input (?=[^>]*type="month")(?=[^>]*name="month")(?=[^>]*value="2026-10")/);
    expect(TEXT).toContain("Show this month");
    expect(MARKUP).toMatch(anchor({ href: "?month=2026-10" }, "Last month</a>"));
    expect(MARKUP).toMatch(anchor({ href: "?month=2026-11" }, "This month so far</a>"));
    expect(MARKUP).toMatch(anchor({ "aria-label": "Previous month: September 2026", href: "?month=2026-09" }, "September 2026"));
    expect(MARKUP).toMatch(anchor({ "aria-label": "Next month: November 2026", href: "?month=2026-11" }, "November 2026"));
    // This month has no next one yet.
    const soFar = render(samplePack({ now: new Date("2026-10-25T09:00:00Z") }));
    expect(soFar).not.toContain("Next month:");
    expect(soFar).toMatch(anchor({ href: "?month=2026-09" }, "Last month</a>"));
  });

  it("drops the controls from the print, and prints a line saying what it is", () => {
    expect(MARKUP).toMatch(/<div class="[^"]*print:hidden[^"]*"><form/);
    expect(MARKUP).toContain("hidden text-sm text-ink-2 print:block");
    expect(TEXT).toContain("Vestiarion monthly close pack · Pinecrest Studio (Arc testnet) · October 2026 · read 2026-11-02 09:00 UTC");
    expect(textOf(render(samplePack({ now: new Date("2026-10-25T09:00:00Z") })))).toContain("· October 2026 so far · read 2026-10-25 09:00 UTC");
  });

  it("takes every network name from the workspace's profile", () => {
    const mainnet = textOf(render({ ...PACK, rows: [], totals: { ...PACK.totals, onChain: [] }, network: { id: "arc-mainnet", label: "Arc mainnet" } }));
    expect(mainnet).toContain("Payments appear here once Circle confirms them on Arc mainnet.");
    expect(mainnet).toContain("(Arc mainnet)");
  });
});

describe("the page (close pack CP11, CP14)", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "evidence", "close-pack", "page.tsx"), "utf8");

  it("is the Monthly close pack, gated as every workspace page is", () => {
    expect(page).toContain('export const metadata: Metadata = { title: "Monthly close pack" };');
    expect(page).toContain('title="Monthly close pack"');
    expect(page).toContain("const access = await requireMembership(slug);");
    expect(page).toContain("return inOrg(access, async () =>");
    expect(page).toContain('<DocsLink href="/docs/guides/accountants#the-monthly-close-pack" topic="the monthly close pack" />');
  });

  it("reads the month once from the query, and says when it did not read", () => {
    expect(page).toContain("closePackMonthFrom(await searchParams, now)");
    expect(page).toContain("That month could not be read, so this shows last month. Choose a month with the Month field.");
  });

  it("reads through takeClosePackPageToken, and says when it is out of reads", () => {
    expect(page).toContain("takeClosePackPageToken(access.user.id)");
    expect(page).toMatch(/allowed \? readClosePack\(/);
    expect(page).toContain("The close pack was read many times in a row. Try again in a minute.");
  });

  it("lets a member read it ten times at once, then once every 6 seconds", () => {
    const at = 6_000_000_000_000;
    const member = "close-pack-page-member";
    const reads = Array.from({ length: 11 }, () => takeClosePackPageToken(member, at));
    expect(reads.slice(0, 10).every(Boolean)).toBe(true);
    expect(reads[10]).toBe(false);
    expect(takeClosePackPageToken("another-member", at)).toBe(true);
    expect(takeClosePackPageToken(member, at + 3_000)).toBe(false);
    expect(takeClosePackPageToken(member, at + 6_000)).toBe(true);
  });
});
