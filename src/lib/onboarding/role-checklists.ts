/**
 * Onboarding by role (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md): each role's first
 * real task, as a short checklist ticked from what happened, never from a box a person ticks.
 *
 * - The owner's (R1) is the console's Get started (`../getting-started`): the workspace, a first bill, the agent's
 *   decision, the limits, then what paying on Arc needs. An admin follows it, and sees an owner's step as an owner's.
 * - An approver's (R2): open Approvals, read why a bill is held, then decide it or send it back.
 * - An accountant's (R3): open the accountant console, one workspace's queue in it, book one payment or apply one
 *   receipt, and download the month's hand-off; and, optional, invite a client (accountant client links AC6).
 * - A viewer has none: there is nothing a viewer's first task changes.
 *
 * Pure: the pages read the facts (`./read`) and pass them in. Every step names the permission it takes, and a role's
 * checklist holds no step its permissions refuse (R5); `tests/role-checklists.test.ts` holds every variant to that.
 */

import { approvalAnchor, orgHref } from "../auth/org-paths";
import type { OrgRole } from "../auth/roles";
import type { ChecklistRole, GettingStarted, GettingStartedStep } from "../getting-started";

export type { ChecklistRole } from "../getting-started";

/** What `onboarding_marks` (migration 0114) may hold: the acts no other row records, and each role's dismissal. */
export const ONBOARDING_MARKS = [
  "dismissed_owner",
  "dismissed_approver",
  "dismissed_accountant",
  "approvals_opened",
  "held_reason_seen",
  "accountant_console_opened",
  "accountant_queue_opened",
  "limits_confirmed",
] as const;
export type OnboardingMark = (typeof ONBOARDING_MARKS)[number];

/** The mark that dismisses a role's checklist for good (R4). */
export const DISMISSED: Readonly<Record<ChecklistRole, OnboardingMark>> = {
  owner: "dismissed_owner",
  approver: "dismissed_approver",
  accountant: "dismissed_accountant",
};

export function isChecklistRole(value: unknown): value is ChecklistRole {
  return value === "owner" || value === "approver" || value === "accountant";
}

/** Whose checklist a member follows: an admin the owner's; a viewer none. */
export function checklistRoleOf(role: OrgRole): ChecklistRole | null {
  switch (role) {
    case "owner":
    case "admin":
      return "owner";
    case "approver":
      return "approver";
    case "accountant":
      return "accountant";
    default:
      return null;
  }
}

/**
 * Where a member invited by email lands once they accept (R6): their checklist's first step. An approver opens
 * Approvals, an accountant the accountant console, and anyone else the console, where their checklist is.
 */
export function firstStepHref(role: OrgRole, slug: string): string {
  switch (checklistRoleOf(role)) {
    case "approver":
      return orgHref(slug, "/approvals");
    case "accountant":
      return "/accountant";
    default:
      return orgHref(slug, "/console");
  }
}

function checklist(role: ChecklistRole, title: string, guide: GettingStarted["guide"], steps: GettingStartedStep[], dismissed: boolean): GettingStarted {
  return {
    role,
    title,
    // An optional step neither keeps the checklist showing nor becomes the next one.
    show: !dismissed && steps.some((step) => !step.done && !step.optional),
    steps,
    next: steps.find((step) => !step.done && !step.optional)?.id ?? null,
    guide,
  };
}

export interface ApproverChecklistInput {
  /** `approvals_opened`: this person opened Approvals. */
  approvalsOpened: boolean;
  /** `held_reason_seen`: this person opened Approvals while a bill waited there, its reasons on its card. */
  heldReasonSeen: boolean;
  /** This person decided a held bill: an approval, a rejection, a return, a verdict, or a milestone paid or closed. */
  decided: boolean;
  /** What waits on Approvals now, as the console's Needs you tile counts it. */
  waitingCount: number;
  /** The first bill waiting, so the steps open Approvals at its card. */
  firstWaitingId?: string | null;
  dismissed: boolean;
}

/**
 * An approver's checklist (R2). Deciding a bill ticks the two steps before it too: the card a bill is decided on says
 * why it was held.
 */
export function approverChecklist(input: ApproverChecklistInput): GettingStarted {
  const atBill = input.firstWaitingId ? `/approvals#${approvalAnchor(input.firstWaitingId)}` : "/approvals";
  const waiting = input.waitingCount > 0;
  const steps: GettingStartedStep[] = [
    {
      id: "approvals",
      title: "Open Approvals",
      body: "Every bill the agent would not pay on its own waits there for an owner, admin or approver, oldest due date first.",
      path: "/approvals",
      done: input.approvalsOpened || input.decided,
      ownerOnly: false,
      needs: null,
    },
    {
      id: "held_reason",
      title: "Read why a bill is held",
      body: waiting
        ? "Each card says what the agent decided, why, and what would let it pay: a rule code applied, a detail missing, a limit reached."
        : "Nothing is held right now. When the agent holds a bill, its card on Approvals says why, and this step ticks once you have opened Approvals while it waits.",
      path: atBill,
      done: input.heldReasonSeen || input.decided,
      ownerOnly: false,
      needs: null,
    },
    {
      id: "decide",
      title: "Decide it, or send it back",
      body: "Approve and pay it, Reject it with a reason, or Return to agent, which sends it back to the agent's next cycle. In shadow mode, give your verdict instead.",
      path: atBill,
      done: input.decided,
      ownerOnly: false,
      needs: "approval.decide",
    },
  ];
  return checklist("approver", "Get started as an approver", "first-payment#6-approve-a-held-payment", steps, input.dismissed);
}

export interface AccountantChecklistInput {
  /** `accountant_console_opened`, in any of the workspaces the person keeps the books of. */
  consoleOpened: boolean;
  /** `accountant_queue_opened`: the console narrowed to one workspace's queue with Only this one. */
  queueOpened: boolean;
  /** This person approved a payment's booking in the accounting tool (`accounting_payment_approved`). */
  booked: boolean;
  /** This person applied money received to a receivable (`ar_payment_applied`). */
  applied: boolean;
  /** This person downloaded a month's hand-off (`handoff_exported`). */
  handedOff: boolean;
  /** The workspace the steps open: one with a booking waiting for this person, the one the queue is narrowed to, or the first. */
  workspaceSlug: string;
  /** A booking waiting for this accountant to review, where there is one they may book: the bookings review. */
  bookHref?: string | null;
  /**
   * Whether one of this person's client links was used (accountant client links AC6). Absent where client links do not
   * work yet (before migration 0143): no step.
   */
  clientInvited?: boolean;
  dismissed: boolean;
}

/** An accountant's checklist (R3), on the accountant console, where an invitation lands them. */
export function accountantChecklist(input: AccountantChecklistInput): GettingStarted {
  const slug = input.workspaceSlug;
  const handoff = new URLSearchParams({ org: slug, format: "csv" });
  const steps: GettingStartedStep[] = [
    {
      id: "console",
      title: "Open the accountant console",
      body: "Every workspace you look after, how long its items have been open, and one queue of what needs attention across them.",
      path: "/",
      href: "/accountant",
      done: input.consoleOpened,
      ownerOnly: false,
      needs: null,
    },
    {
      id: "queue",
      title: "Open one workspace's queue",
      body: "Only this one, on a workspace's card, narrows the queue to it: what you can act on first, then the oldest.",
      path: "/",
      href: `/accountant?${new URLSearchParams({ workspace: slug }).toString()}`,
      done: input.queueOpened,
      ownerOnly: false,
      needs: null,
    },
    {
      id: "book",
      title: "Book one payment or apply one receipt",
      body: input.bookHref
        ? "A payment made on Arc waits for your review before it is booked in the accounting tool. Or apply money a customer sent to their invoices, on the Receivables tab."
        : "Apply money a customer sent to their invoices, on the Receivables tab, or review a payment made on Arc and book it in the accounting tool once one waits.",
      path: input.bookHref ?? "/invoices?tab=receivables",
      done: input.booked || input.applied,
      ownerOnly: false,
      needs: input.bookHref ? "accounting.book" : "receivables.reconcile",
    },
    {
      id: "handoff",
      title: "Download the month's hand-off",
      body: "Last month's decisions, payments, bookings and open items, as a CSV for your books. Each download is recorded in the workspace's ledger.",
      path: "/",
      href: `/api/accountant/handoff?${handoff.toString()}`,
      download: true,
      done: input.handedOff,
      ownerOnly: false,
      needs: null,
    },
    // A person's own step, in no workspace: the link is theirs, so it takes no permission there.
    ...(input.clientInvited === undefined
      ? []
      : [
          {
            id: "invite_client" as const,
            title: "Invite a client",
            body: "Send a client a link from Invite a client: they open their own workspace in shadow mode, with you in it as its accountant.",
            path: "/",
            href: "/accountant#invite-client-title",
            done: input.clientInvited,
            ownerOnly: false,
            needs: null,
            optional: true,
          },
        ]),
  ];
  return checklist("accountant", "Get started as an accountant", "accountants", steps, input.dismissed);
}
