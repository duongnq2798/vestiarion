import { milestoneDecision } from "@/components/vx/map";
import type { Decision } from "@/components/vx/types";
import { buildEvidenceChain, type EvidenceChain, type EvidenceEntry, type EvidenceInput } from "@/lib/evidence-chain";
import { LINK_WORDS, type LinkAccess } from "@/lib/evidence-links/check";
import { NOT_CHECKED_WORDS } from "@/lib/evidence-links/allow-list";
import { gettingStarted } from "@/lib/getting-started";
import type { MilestoneRow } from "@/lib/queries";
import { homeChain } from "@/lib/payee-chains";
import { approverChecklist } from "@/lib/onboarding/role-checklists";
import type { EntryCheck } from "@/lib/receipts/verify";

/**
 * Sample data for the pictures of onboarding by role and evidence access
 * (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md, `role-onboarding-shots/`): an owner's
 * checklist after the agent's first decision, waiting for the limits; an approver's after opening Approvals while a bill
 * waits there; an accountant's on the accountant console; and a contractor milestone whose pull request can't be opened,
 * beside a hand verification's link that is not checked. Every checklist and label is worked out by the app's own
 * functions. No slug, link or person here is real: a form sent from the pictures reaches no workspace.
 */

export const ONBOARDING_SLUG = "northstar-studio";

/** A sandbox on Arc testnet with no wallet: the first bill added and decided, the limits still to set or keep. */
export const OWNER_CHECKLIST = gettingStarted({
  mode: "sandbox",
  accounts: [{ kind: "operating", circle_wallet_id: null, balance: 0 }],
  counterparties: [{ name: "Brightline Video", role: "vendor", address: null }],
  payableCount: 1,
  billCount: 1,
  decidedCount: 1,
  onchainPayments: 0,
  waitingCount: 1,
  network: "arc-testnet",
  limits: { confirmed: false, dailyUsdc: 50, weeklyUsdc: 150 },
});

/** The agent's spending limit the owner's step names, as its panel shows it. */
export const OWNER_LIMITS = { dailyUsdc: 50, weeklyUsdc: 150, spentToday: 0, spentThisWeek: 0, remaining: 50 };

/** An approver who has opened Approvals while a bill waits there, and decided nothing yet. */
export const APPROVER_CHECKLIST = approverChecklist({
  approvalsOpened: true,
  heldReasonSeen: true,
  decided: false,
  waitingCount: 1,
  firstWaitingId: "00000000-0000-4000-8000-0000000000b7",
  dismissed: false,
});

const MILESTONE = "00000000-0000-4000-8000-0000000000a1";
const CONTRACTOR = "00000000-0000-4000-8000-0000000000c7";
const PAYEE = `0x${"5ca1ab1e".repeat(5)}`;
export const PRIVATE_PR = "https://github.com/northstar-studio/brand-site/pull/58";
export const BOUNTY_COMMENT = `${PRIVATE_PR}#issuecomment-2210457`;
export const HAND_LINK = "https://drive.example.test/brand-guide-v3";
const LINA = "00000000-0000-4000-8000-00000000aa21";

const entry = (seq: number, ts: string, actor: string, domain: string, action: string, summary: string, detail: Record<string, unknown>): EvidenceEntry => ({
  seq,
  ts,
  actor,
  domain,
  action,
  summary,
  detail,
  body_hash: "0".repeat(64),
  signature: "0".repeat(128),
  prev_hash: "0".repeat(64),
  hash: seq.toString(16).padStart(64, "0"),
  signing_key_id: null,
});

/**
 * What the evidence page's check said of each given link: the pull request, in a private repository the workspace's GitHub
 * connection does not reach, and the comment that opens.
 */
export const LINK_CHECKS: ReadonlyMap<string, LinkAccess> = new Map<string, LinkAccess>([
  [PRIVATE_PR, { state: "cannot_open", reason: LINK_WORDS.notPublic }],
  [BOUNTY_COMMENT, { state: "open" }],
  [HAND_LINK, { state: "not_checked", reason: NOT_CHECKED_WORDS.host }],
]);

/** A milestone a bounty attached on GitHub, its pull request merged in a private repository the workspace's connection does not reach. */
export function privateMilestoneChain(): EvidenceChain {
  const entries = [
    entry(80, "2026-10-12T09:00:00Z", "human", "compliance", "create_counterparty", "Added Lina Park as a contractor", { by: LINA, counterpartyId: CONTRACTOR, address: PAYEE }),
    entry(81, "2026-10-12T09:20:00Z", "human", "contractor", "github_bounty_attached", "Bounty attached on GitHub", {
      milestoneId: MILESTONE,
      counterpartyId: CONTRACTOR,
      pullRequest: PRIVATE_PR,
      commentUrl: BOUNTY_COMMENT,
      login: "olivia-northstar",
    }),
    entry(82, "2026-10-13T08:10:00Z", "system", "contractor", "verify_milestone_github", "GitHub reported the pull request merged", {
      milestoneId: MILESTONE,
      verificationSource: PRIVATE_PR,
      verificationStatus: "verified",
      pullRequest: PRIVATE_PR,
      mergedAt: "2026-10-13T08:02:00Z",
    }),
  ];
  const input: EvidenceInput = {
    network: "arc-testnet",
    subject: {
      kind: "milestone",
      milestone: {
        id: MILESTONE,
        contractor_id: CONTRACTOR,
        title: "Brand site: new pricing page",
        amount: 180,
        status: "verified",
        verified: true,
        verification_method: "github",
        verification_status: "verified",
        verification_source: PRIVATE_PR,
        verification_checked_at: "2026-10-13T08:10:00Z",
        verified_at: "2026-10-13T08:02:00Z",
        verification_detail: { pullRequest: PRIVATE_PR, mergedAt: "2026-10-13T08:02:00Z" },
        tx_ref: null,
      },
    },
    counterparty: { id: CONTRACTOR, name: "Lina Park", address: PAYEE, chain: homeChain("arc-testnet").id, risk_level: "clear", purchase_order_required: false, sample: false },
    entries,
    screening: { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-10-12T09:01:00Z" },
    payment: null,
    receipt: null,
    people: new Map([[LINA, "olivia@northstar.example"]]),
    checks: { entries: new Map(entries.map((row): [number, EntryCheck] => [row.seq, { ok: true }])), onChain: null, links: LINK_CHECKS },
  };
  return buildEvidenceChain(input);
}

const milestoneRow = (over: Partial<MilestoneRow>): MilestoneRow => ({
  id: MILESTONE,
  contractor_id: CONTRACTOR,
  contractor_name: "Lina Park",
  title: "Brand site: new pricing page",
  amount: 180,
  verification_source: PRIVATE_PR,
  verification_method: "github",
  verification_status: "verified",
  verification_checked_at: "2026-10-13T08:10:00Z",
  verified_at: "2026-10-13T08:02:00Z",
  verification_detail: {},
  verified: true,
  status: "verified",
  agent_reasoning: null,
  tx_ref: null,
  ...over,
});

/** The same milestone's card on Contractors, and a milestone verified by hand with a link on another site. */
export function contractorCards(): Decision[] {
  return [
    milestoneDecision(milestoneRow({}), [], { network: "arc-testnet", riskLevel: "clear", links: LINK_CHECKS }),
    milestoneDecision(
      milestoneRow({
        id: "00000000-0000-4000-8000-0000000000a2",
        title: "Brand guide, third round",
        amount: 95,
        verification_source: HAND_LINK,
        verification_method: "manual",
        verification_status: "unverified",
        verified_at: "2026-10-13T07:40:00Z",
      }),
      [],
      { network: "arc-testnet", riskLevel: "clear", links: LINK_CHECKS }
    ),
  ];
}
