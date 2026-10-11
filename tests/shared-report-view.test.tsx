import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedReportShown } from "@/lib/platform/shared-report";
import type { BaselineState } from "@/lib/report-value";
import { buildSharedReport, type ShareOptions, type SharedReportInput } from "@/lib/shared-report";
import { reportValue } from "@/lib/report-value";
import { buildReport } from "@/lib/workspace-report";
import { bill, decision, facts, payment } from "./support/report-facts";

/**
 * The shared report's page and its view (docs/superpowers/specs/2026-10-10-shared-report-design.md S4, S6, S8, S11,
 * S14), and the value section and live links on the workspace's own report. A dead link names no one; a live one shows
 * labels or names, amounts or "Hidden", each decision with its signature check and its transaction, and never a memo,
 * an id or a person. The read is stood in for; tests/platform-shared-report.test.ts covers it.
 */

const { readSharedReportMock } = vi.hoisted(() => ({ readSharedReportMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/platform/shared-report", () => ({ readSharedReport: readSharedReportMock }));

import SharedReportPage, { metadata } from "@/app/report/[token]/page";
import { ReportShareLinks } from "@/components/ReportShareControl";
import { ReportValue } from "@/components/vx/ReportValue";
import { SharedReport } from "@/components/vx/SharedReport";
import { linkSocialMetadata } from "@/lib/link-previews";
import { txUrl } from "@/lib/payee-chains";

const TOKEN = `vxs_${"A".repeat(43)}`;
const TX = `0x${"b".repeat(64)}`;
const KEY_ID = "0123456789abcdef";
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const FACTS = facts({
  bills: [
    bill("inv-north", { createdAt: "2026-10-02T09:00:00.000Z", payee: { id: "cp-north", name: "Northwind Cloud", mirror: false, sample: false }, amount: 46.41, status: "paid" }),
    bill("inv-atlas", { createdAt: "2026-10-03T09:00:00.000Z", payee: { id: "cp-atlas", name: "Atlas Compute", mirror: false, sample: false }, amount: 61.87, status: "held" }),
  ],
  decisions: [
    decision(11, "inv-north", { ts: "2026-10-02T09:01:00.000Z", reasoning: "Northwind Cloud's bill matches the plan at 46.41 USDC. The memo says October hosting." }),
    decision(12, "inv-atlas", {
      ts: "2026-10-03T09:01:00.000Z",
      action: "ap_hold",
      guardrailBlocked: true,
      guardrailRule: "invoice.match_incomplete",
      resultingStatus: "held",
      reasoning: "Atlas Compute's bill has no receipt of goods yet.",
    }),
  ],
  verdicts: [{ entrySeq: 11, verdict: "agree" }],
  payments: [payment("inv-north", { amount: 46.41, txHash: TX, at: "2026-10-02T09:02:00.000Z" })],
});
const ANSWERED: BaselineState = {
  available: true,
  answer: { id: "b-1", minutesPerBill: 30, peoplePerBill: 2, answeredBy: "user-owner-0001", answeredAt: "2026-10-09T08:00:00.000Z" },
};
const LABELS: ShareOptions = { names: "labels", amounts: "shown", title: "workspace" };

function shown(over: Partial<SharedReportInput> = {}): SharedReportShown {
  const view = buildSharedReport({
    facts: FACTS,
    actuals: { available: false },
    baseline: ANSWERED,
    options: LABELS,
    name: "Harbor Books",
    sharedAt: "2026-10-10T08:00:00.000Z",
    knownNames: ["Northwind Cloud", "Atlas Compute"],
    now: "2026-10-11T12:00:00.000Z",
    ...over,
  });
  return {
    ...view,
    decisions: view.decisions.map((row) => ({
      ...row,
      link: { body_hash: "1".repeat(64), signature: "2".repeat(128), prev_hash: "3".repeat(64), hash: "4".repeat(64), signing_key_id: KEY_ID },
    })),
    publicKeys: { [KEY_ID]: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n" },
  };
}

const page = async () => renderToStaticMarkup(await SharedReportPage({ params: Promise.resolve({ token: TOKEN }) }));

beforeEach(() => {
  readSharedReportMock.mockReset();
});

describe("the shared report's page", () => {
  it("is not indexed, and its card and title name no workspace", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("Shared report");
    expect(metadata.openGraph).toEqual(linkSocialMetadata("report").openGraph);
    expect(metadata.twitter).toEqual(linkSocialMetadata("report").twitter);
    expect(source("src/app/report/[token]/page.tsx")).not.toMatch(/generateMetadata/);
  });

  it("reads the link it was opened with, and shows the report", async () => {
    readSharedReportMock.mockResolvedValue(shown());
    const markup = text(await page());
    expect(readSharedReportMock).toHaveBeenCalledWith(TOKEN);
    expect(markup).toContain("Harbor Books");
    expect(markup).toContain("Live: recomputed each time this page opens.");
  });

  it("says a dead link is no longer shared, and names no one", async () => {
    readSharedReportMock.mockResolvedValue(null);
    const markup = text(await page());
    expect(markup).toContain("This report is no longer shared.");
    expect(markup).not.toContain("Harbor Books");
  });

  it("says a read that failed could not load, and names no one", async () => {
    readSharedReportMock.mockRejectedValue(new Error("connection reset for org 5d0f3a2e"));
    const markup = text(await page());
    expect(markup).toContain("This report could not load. Try again in a moment.");
    expect(markup).not.toContain("5d0f3a2e");
  });
});

describe("a shared report's view", () => {
  it("names the workspace, the period, the network, and that it is live", () => {
    const markup = text(renderToStaticMarkup(<SharedReport view={shown()} />));
    expect(markup).toContain("Harbor Books");
    expect(markup).toContain("What Vestiarion's agent did with this business's bills on Arc testnet, from Oct 1, 2026 to now.");
    expect(markup).toContain("Live: recomputed each time this page opens. Computed Oct 11, 2026, 12:00 UTC. Shared since Oct 10, 2026.");
    expect(markup).toContain("Payments on Arc testnet, in test USDC.");
  });

  it("gives a neutral title when the share hides the name", () => {
    const markup = text(renderToStaticMarkup(<SharedReport view={shown({ options: { ...LABELS, title: "neutral" }, name: null })} />));
    expect(markup).toContain("A business on Vestiarion");
    expect(markup).not.toContain("Harbor Books");
    expect(markup).toContain("the business's bills");
  });

  it("shows suppliers as labels, in the reasoning too, and only the reasoning's first sentence", () => {
    const markup = text(renderToStaticMarkup(<SharedReport view={shown()} />));
    expect(markup).toContain("Supplier A");
    expect(markup).toContain("Supplier B");
    expect(markup).toContain("Supplier A's bill matches the plan at 46.41 USDC.");
    expect(markup).not.toMatch(/Northwind|Atlas/);
    expect(markup).not.toContain("The memo says");
    expect(markup).toContain("Code refused it: its three-way match is incomplete.");
  });

  it("hides every amount when the share says so", () => {
    const markup = text(renderToStaticMarkup(<SharedReport view={shown({ options: { ...LABELS, amounts: "hidden" } })} />));
    expect(markup).not.toMatch(/46\.41|61\.87/);
    expect(markup).toContain("Amounts hidden");
    expect(markup).toContain("Hidden");
    expect(markup).toContain("Supplier A's bill matches the plan at # USDC.");
  });

  it("links no transaction when amounts are hidden, and says why", () => {
    const markup = renderToStaticMarkup(<SharedReport view={shown({ options: { ...LABELS, amounts: "hidden" } })} />);
    expect(markup).not.toContain("/tx/");
    expect(markup).not.toContain(TX.slice(2, 12));
    expect(text(markup)).toContain("Not linked");
    expect(text(markup)).toContain("Transactions are not linked while amounts are hidden: the public explorer shows what each one carried.");
  });

  it("gives each decision its entry number, its signature check and its transaction on the explorer", () => {
    const markup = renderToStaticMarkup(<SharedReport view={shown()} />);
    expect(text(markup)).toContain("Ledger entry #11");
    expect(text(markup)).toContain("Ledger entry #12");
    expect(markup.match(/<button[^>]*>(?:(?!<\/button>).)*Check its signature/g)).toHaveLength(2);
    expect(markup).toContain(`href="${txUrl("arc-testnet", TX)}"`);
    expect(text(markup)).toContain("Paid on Arc");
    expect(text(markup)).toContain("A person agreed");
  });

  it("names each Check its signature by its own decision, for a screen reader", () => {
    const markup = renderToStaticMarkup(<SharedReport view={shown()} />);
    const described = [...markup.matchAll(/<button[^>]*aria-describedby="([^"]+)"[^>]*>(?:(?!<\/button>).)*Check its signature/g)].map((match) => match[1]);
    expect(described).toHaveLength(2);
    expect(new Set(described).size).toBe(2);
    for (const id of described) expect(markup).toContain(`id="${id}"`);
  });

  it("says a sandbox's payments are simulated, with no transaction to open", () => {
    const sandbox = facts({ ...FACTS, sandbox: true, payments: FACTS.payments.map((item) => ({ ...item, simulated: true })) });
    const markup = renderToStaticMarkup(<SharedReport view={shown({ facts: sandbox })} />);
    expect(text(markup)).toContain("Sandbox: payments here are simulated.");
    expect(text(markup)).toContain("Simulated");
    expect(markup).not.toContain("/tx/");
  });

  it("never carries an invoice id, a supplier's id or a person's", () => {
    const markup = renderToStaticMarkup(<SharedReport view={shown({ options: { ...LABELS, names: "shown" } })} />);
    for (const secret of ["inv-north", "inv-atlas", "cp-north", "user-owner-0001"]) expect(markup).not.toContain(secret);
  });

  it("keeps value in three groups, never added together, and says the estimate is one", () => {
    const markup = text(renderToStaticMarkup(<SharedReport view={shown()} />));
    expect(markup).toContain("Three kinds of figures, never added together");
    expect(markup).toContain("Measured");
    expect(markup).toContain("From the business's answer");
    expect(markup).toContain("Not counted");
    expect(markup).toContain("Time saved, estimated");
    expect(markup).toContain("About 1 h");
    expect(markup).toContain("2 bills the agent decided × 30 min, the time one bill took before.");
    expect(markup).toContain("Answered on Oct 9, 2026.");
    expect(markup).not.toMatch(/Answered by/);
    expect(text(renderToStaticMarkup(<ReportValue value={shown().value} audience="public" />))).not.toMatch(/total/i);
  });

  it("says agent vs what really happened is not recorded before it is", () => {
    expect(text(renderToStaticMarkup(<SharedReport view={shown()} />))).toContain("What the business paid outside Vestiarion is not recorded here yet.");
  });
});

describe("value on the workspace's own report", () => {
  const value = (baseline: BaselineState) => reportValue(buildReport(FACTS), baseline);

  it("asks an owner the question when there is no answer", () => {
    const markup = text(renderToStaticMarkup(<ReportValue value={value({ available: true, answer: null })} audience="member" answer={<span>ANSWER FORM</span>} />));
    expect(markup).toContain("How long did one bill take you before Vestiarion?");
    expect(markup).toContain("ANSWER FORM");
  });

  it("tells any other member an owner answers", () => {
    const markup = text(renderToStaticMarkup(<ReportValue value={value({ available: true, answer: null })} audience="member" />));
    expect(markup).toContain("No answer given yet, so nothing is estimated.");
  });

  it("says the answer is not set up before migration 0095 runs, and keeps the measured figures", () => {
    const markup = text(renderToStaticMarkup(<ReportValue value={value({ available: false })} audience="member" />));
    expect(markup).toContain("Your answer is not set up on this deployment yet.");
    expect(markup).toContain("Bills handled");
  });

  it("names who answered, and when", () => {
    const markup = text(renderToStaticMarkup(<ReportValue value={value(ANSWERED)} audience="member" answeredBy="owner@harbor.example" />));
    expect(markup).toContain("From your answer");
    expect(markup).toContain("Answered by owner@harbor.example on Oct 9, 2026.");
    expect(markup).toContain("A person's verdict still takes time, and it is not taken off.");
  });
});

describe("the report's live links", () => {
  const live = [{ id: "5d0f3a2e-8c1b-4f7a-9e6d-0000000005e1", shows: "Supplier labels, amounts shown, the workspace's name as its title", by: "owner@harbor.example", createdAt: "2026-10-10T08:00:00.000Z" }];

  it("lists each, who made it and what it shows, with Stop sharing for an owner or admin", () => {
    const markup = text(renderToStaticMarkup(<ReportShareLinks orgSlug="harbor" live={live} stopped={1} canStop />));
    expect(markup).toContain("1 live · 1 stopped");
    expect(markup).toContain("Supplier labels, amounts shown, the workspace's name as its title");
    expect(markup).toContain("Made by owner@harbor.example on Oct 10, 2026");
    expect(markup).toContain("Stop sharing");
  });

  it("shows any other member the links, without Stop sharing", () => {
    const markup = text(renderToStaticMarkup(<ReportShareLinks orgSlug="harbor" live={live} stopped={0} canStop={false} />));
    expect(markup).toContain("Made by owner@harbor.example");
    expect(markup).not.toContain("Stop sharing");
  });

  it("says when the report is not shared", () => {
    expect(text(renderToStaticMarkup(<ReportShareLinks orgSlug="harbor" live={[]} stopped={0} canStop={false} />))).toContain(
      "This report is not shared. An owner or admin can share it by a link."
    );
  });
});

describe("the workspace's own report page", () => {
  // A server component the suite does not render: how it gates the controls is read from its source, as
  // tests/mainnet-copy-pages.test.tsx reads the shell's wiring.
  const page = source("src/app/o/[slug]/report/page.tsx").replace(/\s+/g, " ");

  it("reads the links and the answer inside the workspace's scope", () => {
    expect(page).toMatch(/return inOrg\(access, async \(\) => \{.*listReportShares\(db\(\)\).*readBaseline\(db\(\)\)/);
  });

  it("offers Share this report to an owner or admin, and the answer's form to an owner", () => {
    expect(page).toContain('const canShare = can(access.membership.role, "report.share");');
    expect(page).toContain('const canAnswer = can(access.membership.role, "org.administer");');
    expect(page).toContain("{canShare && <ReportShareButton orgSlug={slug} available={shares.available} />}");
    expect(page).toMatch(/canAnswer && baseline\.available \? \( <ReportBaselineControl/);
  });

  it("shows every member the live links, and Stop sharing to an owner or admin", () => {
    expect(page).toContain("{shares.available && <ReportShareLinks orgSlug={slug} live={liveLinks} stopped={shares.stopped} canStop={canShare} />}");
  });
});
