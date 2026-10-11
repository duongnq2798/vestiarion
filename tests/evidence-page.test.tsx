import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEvidenceChain, EVIDENCE_MEANINGS, EVIDENCE_WORDS, SIGNED_ENTRY_PROVES, type EvidenceChain } from "@/lib/evidence-chain";
import type { EvidenceRead } from "@/lib/evidence-read";
import { txUrl } from "@/lib/payee-chains";
import { ALICE, at, BOB, CP, entry, INVOICE, MILESTONE, okChecks, paidInFull, TX } from "./support/evidence-fixtures";

/**
 * The evidence page (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E1, E2, E3, E10): a built chain as a
 * member reads it — labels in words beside icons, the links' states, the way into the trail and the audit log, the
 * browser's check — and who may see, download and share it, by role. The reader is stood in for; its own test reads.
 */

vi.mock("server-only", () => ({}));

const { readEvidenceMock, ACCESS } = vi.hoisted(() => ({
  readEvidenceMock: vi.fn(),
  ACCESS: {
    user: { id: "u-alice", email: "alice@northstar.test" },
    membership: { orgId: "org-1", slug: "northstar", name: "Northstar", mode: "live", role: "viewer", network: "arc-testnet" },
  },
}));
vi.mock("@/lib/auth/membership", () => ({ requireMembership: vi.fn(async () => ACCESS) }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/evidence-read", () => ({ readEvidence: readEvidenceMock }));
vi.mock("@/lib/queries", () => ({ stats: async () => ({ day: 3, clockMode: "real", lastCycleAt: null }) }));
vi.mock("@/lib/shell-status", () => ({ shellStatus: async () => ({ shadow: false, screening: { live: true, source: "OpenSanctions" } }) }));
vi.mock("@/lib/circle", () => ({ shellModes: () => ({ mode: "live", earnMode: "simulate", held: false }) }));
// The shell draws the frame from the layout's context, which a page alone does not have: the page's own content is what is read here.
vi.mock("@/components/vx/Shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/vx/Shell")>()),
  ProductShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import EvidencePage, { metadata } from "@/app/o/[slug]/evidence/[kind]/[id]/page";
import { EvidenceAccess, EvidenceChainView, LINK_STATE } from "@/components/vx/EvidenceChain";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const view = (chain: EvidenceChain) => renderToStaticMarkup(<EvidenceChainView chain={chain} orgSlug="northstar" publicKeys={{}} />);
const PAID = buildEvidenceChain(paidInFull());

describe("a payable's chain, as the page draws it", () => {
  const markup = view(PAID);

  it("draws the nine links in order, each a heading with its label in words", () => {
    const headings = [...markup.matchAll(/<h2 id="evidence-step-([a-z]+)"[^>]*>.*?<\/h2>/g)].map((match) => match[1]);
    expect(headings).toEqual(["agreed", "delivered", "bill", "payee", "decision", "people", "payment", "receipt", "signatures"]);
    expect(text(markup)).toContain("1 What was agreed Reads as Stated by a person");
    expect(text(markup)).toContain("Signatures Reads as Checked by code");
  });

  it("explains the seven words once, each beside its icon, with how many facts it holds", () => {
    for (const kind of Object.keys(EVIDENCE_WORDS) as Array<keyof typeof EVIDENCE_WORDS>) {
      expect(markup.split(EVIDENCE_MEANINGS[kind].replace(/'/g, "&#x27;")).length - 1, kind).toBe(1);
    }
    expect(text(markup)).toContain("How each fact is known");
    expect(text(markup)).toContain(`Stated by a person ${PAID.tally.stated} facts`);
    // Every label carries an icon, so none is told by colour alone.
    const badges = [...markup.matchAll(/<span[^>]*class="[^"]*rounded-full[^"]*"[^>]*>(<svg[^>]*aria-hidden="true"[^]*?<\/svg>)?/g)];
    expect(badges.length).toBeGreaterThan(10);
  });

  it("says who stated a fact, and when, and links the entries it rests on in the audit log", () => {
    expect(text(markup)).toContain("By alice@northstar.test · Oct 5, 2026, 09:30 UTC");
    expect(markup).toContain('href="/o/northstar/audit?before=21#seq-20"');
    expect(text(markup)).toContain("Entry #0020");
  });

  it("links the transaction as checked against the chain's own record, and the decision into its trail", () => {
    expect(markup).toContain(`href="${txUrl("arc-testnet", TX)}"`);
    expect(text(markup)).toContain(`The transaction (opens in a new tab) · ${LINK_STATE.checked}`);
    expect(markup).toContain(`href="/o/northstar/invoices?history=all#trail-${INVOICE}"`);
    expect(text(markup)).toContain("How the agent decided, step by step");
  });

  it("says in one plain line what a signature proves, and checks every entry again in the reader's browser", () => {
    expect(text(markup)).toContain(SIGNED_ENTRY_PROVES);
    expect(text(markup)).toContain("Checking 6 entries again in your browser…");
    expect(text(markup)).toContain("Every entry, checked here one by one (6)");
    expect(text(markup)).toContain("Verifies");
  });

  it("names the record and where it lives", () => {
    expect(text(markup)).toContain("October design retainer Payee Northstar Studio Amount 12.50 USDC Status Paid Record A bill on Bills & receivables");
    expect(markup).toContain('href="/o/northstar/invoices"');
  });
});

describe("what a fact that is not known says", () => {
  it("shows a missing fact with what would fill it", () => {
    const chain = buildEvidenceChain(paidInFull({ receipt: null }));
    expect(text(view(chain))).toContain("Not shared. An owner or admin shares it with Share receipt on Bills & receivables.");
  });

  it("marks bad news in words as well as colour", () => {
    const input = paidInFull();
    const chain = buildEvidenceChain({ ...input, checks: { ...input.checks, onChain: { state: "mismatch", reason: "No transfer of 12.5 USDC to the payee is in this transaction." } } });
    const markup = view(chain);
    expect(text(markup)).toContain("Needs attention: Paid 12.50 USDC");
    expect(text(markup)).toContain(`· ${LINK_STATE.contradicted}`);
  });

  it("shows a deliverable a person gave as a link Vestiarion did not open", () => {
    const LINK = "https://drive.example.test/handoff";
    const input = paidInFull();
    const entries = [
      entry(70, "08:30:00", "human", "create_milestone", { by: ALICE, milestoneId: MILESTONE, counterpartyId: CP, amount: 25 }, "contractor"),
      entry(71, "08:31:00", "human", "verify_milestone_manual", { by: BOB, milestoneId: MILESTONE, verificationSource: LINK }, "contractor"),
    ];
    const chain = buildEvidenceChain({
      ...input,
      subject: {
        kind: "milestone",
        milestone: {
          id: MILESTONE, contractor_id: CP, title: "Five October posts", amount: 25, status: "verified", verified: true, verification_method: "manual",
          verification_status: "verified", verification_source: LINK, verification_checked_at: null, verified_at: at("08:31:00"), verification_detail: {}, tx_ref: null,
        },
      },
      entries,
      payment: null,
      receipt: null,
      checks: { entries: okChecks(entries), onChain: null },
    });
    const markup = view(chain);
    expect(markup).toMatch(/<a href="https:\/\/drive\.example\.test\/handoff" target="_blank" rel="noreferrer nofollow ugc"/);
    expect(text(markup)).toContain(`· ${LINK_STATE.not_opened}`);
    expect(text(markup)).toContain("Record A milestone on Contractors");
    expect(markup).not.toContain("How the agent decided, step by step");
  });
});

describe("who can see this (E10)", () => {
  const access = (props: Parameters<typeof EvidenceAccess>[0]) => text(renderToStaticMarkup(<EvidenceAccess {...props} />));

  it("names every member for the page and the download, and nobody outside", () => {
    const words = access({ kind: "invoice", receipt: "shared", role: "owner", canShare: true });
    expect(words).toContain("This page Every member of this workspace, viewers included.");
    expect(words).toContain("Download evidence Every member, as the audit export.");
    expect(words).toContain("Nothing on this page shares or changes anything: Download evidence is its only action.");
  });

  it("says whether the receipt is shared now, was stopped, or is not shared", () => {
    expect(access({ kind: "invoice", receipt: "shared", role: "owner", canShare: true })).toContain("Only the receipt, which is shared now");
    expect(access({ kind: "invoice", receipt: "stopped", role: "owner", canShare: true })).toContain("the receipt was shared, then its link was stopped");
    expect(access({ kind: "invoice", receipt: "none", role: "owner", canShare: true })).toContain("the receipt is not shared");
  });

  it("tells an owner or admin they may share it, and anyone else to ask one", () => {
    expect(access({ kind: "invoice", receipt: "none", role: "admin", canShare: true })).toContain("As an owner or admin, you can share it or stop sharing it with Share receipt on Bills & receivables.");
    expect(access({ kind: "invoice", receipt: "none", role: "viewer", canShare: false })).toContain("Your role, viewer, cannot share it: an owner or admin shares it");
  });

  it("offers no one a receipt for a payment with nothing on chain, which has none to share", () => {
    const words = access({ kind: "invoice", receipt: "unavailable", role: "owner", canShare: true });
    expect(words).toContain("Nothing: only a payment Vestiarion made on chain has a receipt, and this bill has none.");
    expect(words).not.toContain("you can share it");
    expect(words).not.toContain("cannot share it");
  });

  it("says nothing of a milestone leaves the workspace", () => {
    const words = access({ kind: "milestone", receipt: null, role: "owner", canShare: true });
    expect(words).toContain("a milestone has no receipt, so none of this leaves the workspace");
    expect(words).not.toContain("Share receipt");
  });
});

describe("the page", () => {
  const params = (kind: string, id: string) => ({ params: Promise.resolve({ slug: "northstar", kind, id }) });
  const read = (chain: EvidenceChain, receipt: EvidenceRead["receipt"] = { state: "shared" }): EvidenceRead => ({ chain, publicKeys: {}, receipt });
  const page = async (kind = "invoice", id = INVOICE) => renderToStaticMarkup(await EvidencePage(params(kind, id)));

  beforeEach(() => {
    readEvidenceMock.mockReset();
    ACCESS.membership.role = "viewer";
  });

  it("is titled for what it shows", () => {
    expect(metadata.title).toBe("Payment evidence");
  });

  it("is the workspace's not-found page for a record it does not hold, a receivable or an id that is not one", async () => {
    readEvidenceMock.mockResolvedValue(null);
    await expect(EvidencePage(params("invoice", INVOICE))).rejects.toEqual(expect.objectContaining({ digest: expect.stringContaining("404") }));
    await expect(EvidencePage(params("receivable", "x"))).rejects.toEqual(expect.objectContaining({ digest: expect.stringContaining("404") }));
    expect(readEvidenceMock).toHaveBeenCalledWith("receivable", "x");
  });

  it("asks Why it was paid of a paid payable, with the download as its one action", async () => {
    readEvidenceMock.mockResolvedValue(read(PAID));
    const markup = await page();
    expect(markup).toMatch(/<h1[^>]*>Why it was paid<\/h1>/);
    expect(text(markup)).toContain("October design retainer: 12.50 USDC to Northstar Studio.");
    expect(markup).toContain(`href="/api/evidence?org=northstar&amp;kind=invoice&amp;id=${INVOICE}"`);
    expect(text(markup)).toContain("Download evidence");
    expect(text(markup)).not.toContain("Not paid yet");
    // A viewer reads it, and is told who shares the receipt.
    expect(text(markup)).toContain("Your role, viewer, cannot share it");
  });

  it("shows an open bill's evidence so far, read-only", async () => {
    const base = paidInFull();
    const chain = buildEvidenceChain({ ...base, subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "held", tx_ref: null } as never }, payment: null, receipt: null });
    readEvidenceMock.mockResolvedValue(read(chain, { state: "unavailable" }));
    ACCESS.membership.role = "owner";
    const markup = await page();
    expect(markup).toMatch(/<h1[^>]*>Evidence so far<\/h1>/);
    expect(text(markup)).toContain("Not paid yet. This is the chain so far, read-only: nothing on this page pays, approves or changes anything.");
    expect(text(markup)).toContain("Nothing: only a payment Vestiarion made on chain has a receipt, and this bill has none.");
    expect(text(markup)).not.toContain("you can share it");
  });

  it("says a rejected bill was not paid", async () => {
    const base = paidInFull();
    const rejected = entry(45, "12:00:00", "human", "approval_rejected", { by: BOB, invoiceId: INVOICE });
    const chain = buildEvidenceChain({
      ...base,
      subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "rejected", tx_ref: null } as never },
      entries: [rejected],
      payment: null,
      receipt: null,
      checks: { entries: okChecks([rejected]), onChain: null },
    });
    readEvidenceMock.mockResolvedValue(read(chain, { state: "none" }));
    expect(text(await page())).toContain("Not paid: a person rejected this bill.");
  });
});

describe("the page's source", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "evidence", "[kind]", "[id]", "page.tsx"), "utf8");

  it("reads the evidence inside the workspace's scope, after its params and the membership check", () => {
    expect(source).toMatch(/const \{ slug, kind, id \} = await params;\s+const access = await requireMembership\(slug\);\s+return inOrg\(access, async \(\) => \{\s+const \[read, dashboardStats\] = await Promise\.all\(\[readEvidence\(kind, id\), stats\(\)\]\);\s+if \(!read\) notFound\(\);/);
  });

  it("hands the shell its status, read in scope, like every workspace page", () => {
    expect(source.replace(/\s+/g, " ")).toMatch(/<ProductShell [^>]*status=\{await shellStatus\(\)\}/);
  });
});
