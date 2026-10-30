import { describe, expect, it } from "vitest";
import { acceptable, acceptanceKpis, planRead, selfAcceptance, stateWords, type LinkFacts } from "@/lib/linear/acceptance";
import { DELIVERABLES_BYTES, deliverablesOf, fingerprintOf, storedBytes } from "@/lib/linear/deliverables";
import { issueRefOf, linksToIssue } from "@/lib/linear/urls";

/**
 * Accepting work delivered in Linear, by the rules alone (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md
 * LN4 to LN10, LN15): what a pasted link or ID is read as, what an issue delivers and its fingerprint, what each read does
 * to a link, who may accept, and the card's figures. Pure: no Linear, no database.
 */

const ATTACHMENT = "4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e01";
const COMPLETED_AT = "2026-10-31T08:30:00.000Z";
const FP = "a".repeat(64);

describe("an issue's link or ID (Linear acceptance LN4)", () => {
  it("takes an issue's link, with or without its title, and its ID alone, in any case", () => {
    expect(issueRefOf("https://linear.app/fernhill/issue/ENG-123/billing-export")).toEqual({ identifier: "ENG-123", workspaceKey: "fernhill" });
    expect(issueRefOf("https://linear.app/fernhill/issue/ENG-123")).toEqual({ identifier: "ENG-123", workspaceKey: "fernhill" });
    expect(issueRefOf("  ENG-123 ")).toEqual({ identifier: "ENG-123", workspaceKey: null });
    expect(issueRefOf("eng-7")).toEqual({ identifier: "ENG-7", workspaceKey: null });
  });

  it("reads nothing else: another host, http, a port, credentials, another Linear page, a malformed ID", () => {
    for (const raw of [
      "https://linear.app.evil.example/fernhill/issue/ENG-1",
      "http://linear.app/fernhill/issue/ENG-1",
      "https://linear.app:8443/fernhill/issue/ENG-1",
      "https://user:pass@linear.app/fernhill/issue/ENG-1",
      "https://linear.app/fernhill/project/billing-1a2b3c",
      "https://linear.app/fernhill/view/abc",
      "ENG123",
      "ENG-",
      "1-123",
      "",
      "x".repeat(1001),
    ]) {
      expect(issueRefOf(raw), raw).toBeNull();
    }
  });

  it("knows a link to the issue itself, which is no deliverable", () => {
    expect(linksToIssue("https://linear.app/fernhill/issue/ENG-123/billing-export", "ENG-123")).toBe(true);
    expect(linksToIssue("https://linear.app/fernhill/issue/ENG-124", "ENG-123")).toBe(false);
  });
});

describe("what an issue delivers, and its fingerprint (LN6)", () => {
  const base = {
    description: "Spec: https://www.figma.com/file/AbC123/billing.\nThis issue: https://linear.app/fernhill/issue/ENG-123/billing-export\nUpload: ![shot](https://uploads.linear.app/abc/def/shot.png)",
    attachments: [{ id: ATTACHMENT, href: "https://github.com/fernhill/app/pull/42", title: "PR #42", updatedAt: "2026-10-31T08:00:00.000Z" }],
    comments: [{ id: "c1", body: "Preview: https://vercel.example/preview/1.", createdAt: null }],
    identifier: "ENG-123",
  };

  it("is the attachments, the description's links (uploads included) and the comments' links, never the issue itself", () => {
    const { deliverables, more } = deliverablesOf(base);
    expect(deliverables.map((item) => [item.kind, item.href])).toEqual([
      ["attachment", "https://github.com/fernhill/app/pull/42"],
      ["link", "https://uploads.linear.app/abc/def/shot.png"],
      ["link", "https://www.figma.com/file/AbC123/billing"],
      ["comment_link", "https://vercel.example/preview/1"],
    ]);
    expect(more).toBe(0);
  });

  it("does not change when an attachment's title or update time changes, or the order Linear answers in", () => {
    const first = deliverablesOf(base);
    const touched = deliverablesOf({ ...base, attachments: [{ ...base.attachments[0], title: "Renamed", updatedAt: "2026-11-01T00:00:00.000Z" }], comments: [...base.comments].reverse() });
    expect(fingerprintOf(touched.deliverables, touched.more)).toBe(fingerprintOf(first.deliverables, first.more));
  });

  it("changes when an attachment, a link or a comment's link is added, removed or replaced", () => {
    const first = fingerprintOf(deliverablesOf(base).deliverables);
    expect(fingerprintOf(deliverablesOf({ ...base, attachments: [] }).deliverables)).not.toBe(first);
    expect(fingerprintOf(deliverablesOf({ ...base, attachments: [{ ...base.attachments[0], href: "https://github.com/fernhill/app/pull/43" }] }).deliverables)).not.toBe(first);
    expect(fingerprintOf(deliverablesOf({ ...base, description: "Spec: https://www.figma.com/file/AbC124/billing" }).deliverables)).not.toBe(first);
    expect(fingerprintOf(deliverablesOf({ ...base, comments: [...base.comments, { id: "c2", body: "v2: https://vercel.example/preview/2", createdAt: null }] }).deliverables)).not.toBe(first);
  });

  it("keeps the first 50 and counts the rest in the fingerprint by number", () => {
    const description = Array.from({ length: 60 }, (_, n) => `https://files.example/${String(n).padStart(2, "0")}`).join("\n");
    const { deliverables, more } = deliverablesOf({ ...base, description, attachments: [], comments: [] });
    expect(deliverables).toHaveLength(50);
    expect(more).toBe(10);
  });

  it("keeps no more than migration 0147's check takes, however long the links, and counts the rest by number (Linear acceptance LN6)", () => {
    const hrefs = Array.from({ length: 50 }, (_, n) => `https://files.example/${String(n).padStart(2, "0")}/${"a".repeat(440)}`);
    const { deliverables, more } = deliverablesOf({ ...base, description: "", attachments: [], comments: [{ id: "c1", body: hrefs.join(" "), createdAt: null }] });
    expect(storedBytes(deliverables)).toBeLessThanOrEqual(DELIVERABLES_BYTES);
    expect(deliverables.length).toBeGreaterThan(20);
    // The first ones in the fingerprint's order are kept; the rest are counted.
    expect(deliverables.map((item) => item.href)).toEqual(hrefs.slice(0, deliverables.length));
    expect(more).toBe(50 - deliverables.length);
    // As Postgres writes jsonb out: a space after each colon and each comma between items, in UTF-8 bytes.
    expect(storedBytes([])).toBe(2);
    expect(storedBytes([{ kind: "link", id: "x", label: "é", href: null }])).toBe('[{"kind": "link", "id": "x", "label": "é", "href": null}]'.length + 1);
  });
});

const link = (fields: Partial<LinkFacts> = {}): LinkFacts => ({ state: "waiting", heldReason: null, acceptedAt: null, acceptedFingerprint: null, acceptedCompletedAt: null, afterPayment: false, ...fields });
const issue = (fields: Partial<{ completed: boolean; canceled: boolean; archived: boolean; completedAt: string | null; fingerprint: string }> = {}) => ({
  kind: "issue" as const,
  completed: true,
  canceled: false,
  archived: false,
  completedAt: COMPLETED_AT,
  fingerprint: FP,
  ...fields,
});
const accepted = link({ state: "accepted", acceptedAt: "2026-10-31T09:00:00.000Z", acceptedFingerprint: FP, acceptedCompletedAt: COMPLETED_AT });

describe("what a read does to a link (LN7, LN10)", () => {
  it("waits while the issue is not done, and is ready once it is done with criteria, never accepted by a read", () => {
    expect(planRead(link(), issue({ completed: false, completedAt: null }), { criteria: true })).toEqual({ kind: "set", state: "waiting", heldReason: null, becameReady: false });
    expect(planRead(link(), issue(), { criteria: true })).toEqual({ kind: "set", state: "ready", heldReason: null, becameReady: true });
    expect(planRead(link({ state: "ready" }), issue(), { criteria: true })).toEqual({ kind: "set", state: "ready", heldReason: null, becameReady: false });
  });

  it("holds a done issue without criteria, a canceled one, an archived or deleted one, and one Linear no longer shows", () => {
    expect(planRead(link(), issue(), { criteria: false })).toMatchObject({ state: "held", heldReason: "no_criteria" });
    expect(planRead(link(), issue({ completed: false, canceled: true, completedAt: null }), { criteria: true })).toMatchObject({ state: "held", heldReason: "canceled" });
    expect(planRead(link(), issue({ archived: true }), { criteria: true })).toMatchObject({ state: "held", heldReason: "archived" });
    expect(planRead(link(), { kind: "gone", reason: "not_found" }, { criteria: true })).toMatchObject({ state: "held", heldReason: "issue_unreachable" });
    // A canceled issue moved back is read as it is now: no acceptance was taken back.
    expect(planRead(link({ state: "held", heldReason: "canceled" }), issue({ completed: false, completedAt: null }), { criteria: true })).toMatchObject({ state: "waiting" });
  });

  it("takes an acceptance back when the issue is reopened, done again, canceled, changed, archived, deleted or gone", () => {
    expect(planRead(accepted, issue(), { criteria: true })).toEqual({ kind: "keep" });
    expect(planRead(accepted, issue({ completed: false, completedAt: null }), { criteria: true })).toEqual({ kind: "withdraw", reason: "reopened" });
    expect(planRead(accepted, issue({ completedAt: "2026-10-31T10:00:00.000Z" }), { criteria: true })).toEqual({ kind: "withdraw", reason: "reopened" });
    expect(planRead(accepted, issue({ completed: false, canceled: true, completedAt: null }), { criteria: true })).toEqual({ kind: "withdraw", reason: "canceled" });
    expect(planRead(accepted, issue({ fingerprint: "b".repeat(64) }), { criteria: true })).toEqual({ kind: "withdraw", reason: "deliverable_changed" });
    expect(planRead(accepted, issue({ archived: true }), { criteria: true })).toEqual({ kind: "withdraw", reason: "archived" });
    expect(planRead(accepted, { kind: "gone", reason: "forbidden" }, { criteria: true })).toEqual({ kind: "withdraw", reason: "issue_unreachable" });
  });

  it("keeps a link held after an acceptance held, whatever Linear says now, until a person accepts again", () => {
    const heldAfter = link({ state: "held", heldReason: "reopened", acceptedAt: "2026-10-31T09:00:00.000Z", acceptedFingerprint: FP, acceptedCompletedAt: COMPLETED_AT });
    expect(planRead(heldAfter, issue(), { criteria: true })).toEqual({ kind: "set", state: "held", heldReason: "reopened", becameReady: false });
    expect(planRead(link({ state: "held", heldReason: "canceled", afterPayment: true }), issue(), { criteria: true })).toMatchObject({ state: "held", heldReason: "canceled" });
  });
});

describe("who may accept (LN8, LN9)", () => {
  const facts = { completed: true, archived: false, criteria: true, milestoneStatus: "pending" };

  it("offers acceptance of a done issue with criteria on a pending milestone only", () => {
    expect(acceptable(link({ state: "ready" }), facts)).toBe(true);
    expect(acceptable(link({ state: "held", heldReason: "reopened" }), facts)).toBe(true);
    expect(acceptable(link({ state: "waiting" }), facts)).toBe(false);
    expect(acceptable(link({ state: "accepted" }), facts)).toBe(false);
    expect(acceptable(link({ state: "ready", afterPayment: true }), facts)).toBe(false);
    expect(acceptable(link({ state: "held", heldReason: "issue_unreachable" }), facts)).toBe(false);
    expect(acceptable(link({ state: "held", heldReason: "archived" }), { ...facts, archived: true })).toBe(false);
    expect(acceptable(link({ state: "ready" }), { ...facts, criteria: false })).toBe(false);
    expect(acceptable(link({ state: "ready" }), { ...facts, milestoneStatus: "verified" })).toBe(false);
  });

  it("refuses the payee by their email as a member, and by a Linear user on the issue who is both the payee and the member", () => {
    expect(selfAcceptance({ memberEmail: "Mai@Fernhill.example", payeeEmail: "mai@fernhill.example", payeeLinearIds: [], memberLinearIds: [] })).toBe("payee_member");
    expect(selfAcceptance({ memberEmail: "owner@business.example", payeeEmail: "mai@fernhill.example", payeeLinearIds: ["u-mai"], memberLinearIds: ["u-mai"] })).toBe("payee_linear");
    expect(selfAcceptance({ memberEmail: "admin@business.example", payeeEmail: "mai@fernhill.example", payeeLinearIds: ["u-mai"], memberLinearIds: ["u-admin"] })).toBeNull();
    expect(selfAcceptance({ memberEmail: null, payeeEmail: null, payeeLinearIds: [], memberLinearIds: [] })).toBeNull();
  });

  it("says every state in plain words", () => {
    expect(stateWords("ready", null, false).label).toBe("Ready for acceptance");
    expect(stateWords("held", "canceled", false).line).toMatch(/canceled in Linear/);
    expect(stateWords("held", "reopened", true).label).toBe("Changed after payment");
  });
});

describe("the card's figures (LN15)", () => {
  it("counts Linear's acceptances and disputes in 30 days, and the median time to the agent's decision, never Asana's", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    const kpis = acceptanceKpis(
      [
        { action: "linear_work_accepted", ts: "2026-10-31T10:00:00Z", milestoneId: "m-1" },
        { action: "milestone_release", ts: "2026-10-31T10:04:00Z", milestoneId: "m-1" },
        { action: "linear_work_accepted", ts: "2026-10-30T10:00:00Z", milestoneId: "m-2" },
        { action: "milestone_hold", ts: "2026-10-30T10:10:00Z", milestoneId: "m-2" },
        { action: "linear_acceptance_withdrawn", ts: "2026-10-31T11:00:00Z", milestoneId: "m-3" },
        { action: "milestone_accepted", ts: "2026-10-31T10:00:00Z", milestoneId: "m-asana" },
        { action: "milestone_acceptance_withdrawn", ts: "2026-10-31T10:00:00Z", milestoneId: "m-asana" },
        { action: "linear_work_accepted", ts: "2026-09-01T10:00:00Z", milestoneId: "m-old" },
      ],
      now
    );
    expect(kpis).toEqual({ manualChecks: 2, disputes: 1, medianMinutesToProposal: 7, proposals: 2 });
  });
});
