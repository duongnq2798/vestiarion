import { describe, expect, it } from "vitest";
import { can, ORG_ROLES, type OrgRole } from "@/lib/auth/roles";
import { gettingStarted, type GettingStarted, type GettingStartedInput } from "@/lib/getting-started";
import {
  accountantChecklist,
  approverChecklist,
  checklistRoleOf,
  DISMISSED,
  firstStepHref,
  ONBOARDING_MARKS,
  type AccountantChecklistInput,
  type ApproverChecklistInput,
} from "@/lib/onboarding/role-checklists";

/**
 * Onboarding by role (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md R1 to R6): each role's
 * checklist holds its own steps, ticks them from what happened, hides for good once dismissed, lands an invited member on
 * its first step, and never offers a step the role's permissions refuse.
 */

const APPROVER: ApproverChecklistInput = { approvalsOpened: false, heldReasonSeen: false, decided: false, waitingCount: 0, dismissed: false };
const ACCOUNTANT: AccountantChecklistInput = {
  consoleOpened: false,
  queueOpened: false,
  booked: false,
  applied: false,
  handedOff: false,
  workspaceSlug: "harbor-bakery",
  dismissed: false,
};
const OWNER: GettingStartedInput = {
  mode: "sandbox",
  accounts: [{ kind: "operating", circle_wallet_id: null, balance: 0 }],
  counterparties: [],
  payableCount: 0,
  onchainPayments: 0,
  waitingCount: 0,
  network: "arc-testnet",
};

const done = (checklist: GettingStarted) => Object.fromEntries(checklist.steps.map((step) => [step.id, step.done]));
const titles = (checklist: GettingStarted) => checklist.steps.map((step) => step.title);

/** Every checklist each role can be shown: the owner's in each of its orders, an approver's and an accountant's in each state. */
function variantsFor(role: OrgRole): GettingStarted[] {
  switch (checklistRoleOf(role)) {
    case "owner":
      return [
        gettingStarted(OWNER),
        gettingStarted({ ...OWNER, accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 0 }] }),
        gettingStarted({ ...OWNER, mode: "live", waitingCount: 1 }),
        gettingStarted({ ...OWNER, network: "arc-mainnet" }),
        gettingStarted({ ...OWNER, shadow: { currency: "USDC", verdictsGiven: 0, billCount: 0 } }),
        gettingStarted({ ...OWNER, mode: "live", shadow: { currency: "EUR", verdictsGiven: 0, billCount: 0 }, waitingCount: 1 }),
      ];
    case "approver":
      return [approverChecklist(APPROVER), approverChecklist({ ...APPROVER, waitingCount: 2, firstWaitingId: "5f1e2d3c-0000-4000-8000-000000000001" })];
    case "accountant":
      return [
        accountantChecklist(ACCOUNTANT),
        accountantChecklist({ ...ACCOUNTANT, bookHref: "/invoices?review=book-xero" }),
        accountantChecklist({ ...ACCOUNTANT, clientInvited: false }),
      ];
    default:
      return [];
  }
}

describe("whose checklist a member follows", () => {
  it("gives an owner and an admin the owner's, an approver and an accountant their own, and a viewer none", () => {
    expect(Object.fromEntries(ORG_ROLES.map((role) => [role, checklistRoleOf(role)]))).toEqual({
      owner: "owner",
      admin: "owner",
      approver: "approver",
      accountant: "accountant",
      viewer: null,
    });
  });

  it("lands a member invited by email on their role's first step", () => {
    expect(firstStepHref("approver", "acme")).toBe("/o/acme/approvals");
    expect(firstStepHref("accountant", "acme")).toBe("/accountant");
    expect(firstStepHref("owner", "acme")).toBe("/o/acme/console");
    expect(firstStepHref("admin", "acme")).toBe("/o/acme/console");
    expect(firstStepHref("viewer", "acme")).toBe("/o/acme/console");
    // The first step of each checklist is that page.
    expect(approverChecklist(APPROVER).steps[0].path).toBe("/approvals");
    expect(accountantChecklist(ACCOUNTANT).steps[0].href).toBe("/accountant");
  });

  it("dismisses each role's checklist with its own mark, one the table takes", () => {
    for (const mark of Object.values(DISMISSED)) expect(ONBOARDING_MARKS).toContain(mark);
  });
});

describe("no step needs a permission the role lacks (R5)", () => {
  it.each(["owner", "approver", "accountant"] as const)("%s: every step of every variant is one the role may take", (role) => {
    for (const checklist of variantsFor(role)) {
      for (const step of checklist.steps) {
        if (step.needs) expect(can(role, step.needs), `${role} ${step.id} needs ${step.needs}`).toBe(true);
      }
    }
  });

  it("admin: a step only an owner may take is shown as an owner's, never offered", () => {
    for (const checklist of variantsFor("admin")) {
      for (const step of checklist.steps) {
        if (step.needs && !can("admin", step.needs)) expect(step.ownerOnly, step.id).toBe(true);
      }
    }
  });

  it("viewer: no checklist at all", () => {
    expect(variantsFor("viewer")).toEqual([]);
  });

  it("each role's checklist is its own: none of another role's steps", () => {
    const ids = (role: OrgRole) => new Set(variantsFor(role).flatMap((checklist) => checklist.steps.map((step) => step.id)));
    const approver = ids("approver");
    const accountant = ids("accountant");
    const owner = ids("owner");
    for (const id of approver) expect(owner.has(id) || accountant.has(id), id).toBe(false);
    for (const id of accountant) expect(owner.has(id), id).toBe(false);
  });
});

describe("the approver's checklist (R2)", () => {
  it("opens Approvals, reads why a bill is held, then decides it or sends it back", () => {
    const checklist = approverChecklist(APPROVER);
    expect(checklist.role).toBe("approver");
    expect(checklist.title).toBe("Get started as an approver");
    expect(titles(checklist)).toEqual(["Open Approvals", "Read why a bill is held", "Decide it, or send it back"]);
    expect(checklist.next).toBe("approvals");
    expect(checklist.guide).toBe("first-payment#6-approve-a-held-payment");
    expect(checklist.steps.find((step) => step.id === "decide")?.body).toContain("Return to agent");
  });

  it("ticks each step from what happened: Approvals opened, a held bill's reasons seen, a decision made", () => {
    expect(done(approverChecklist({ ...APPROVER, approvalsOpened: true }))).toEqual({ approvals: true, held_reason: false, decide: false });
    expect(done(approverChecklist({ ...APPROVER, approvalsOpened: true, heldReasonSeen: true }))).toEqual({ approvals: true, held_reason: true, decide: false });
    // A decision is made on a card that says why the bill was held: it ticks the steps before it.
    expect(done(approverChecklist({ ...APPROVER, decided: true }))).toEqual({ approvals: true, held_reason: true, decide: true });
  });

  it("opens Approvals at the first bill waiting, and says so when nothing is held", () => {
    const waiting = approverChecklist({ ...APPROVER, waitingCount: 1, firstWaitingId: "5f1e2d3c-0000-4000-8000-000000000001" });
    expect(waiting.steps.find((step) => step.id === "held_reason")?.path).toBe("/approvals#payable-5f1e2d3c-0000-4000-8000-000000000001");
    expect(approverChecklist(APPROVER).steps.find((step) => step.id === "held_reason")?.body).toContain("Nothing is held right now");
  });

  it("hides once every step is done, or for good once dismissed", () => {
    expect(approverChecklist({ ...APPROVER, decided: true }).show).toBe(false);
    expect(approverChecklist({ ...APPROVER, dismissed: true }).show).toBe(false);
    expect(approverChecklist(APPROVER).show).toBe(true);
  });
});

describe("the accountant's checklist (R3)", () => {
  it("opens the console, one workspace's queue, books or applies, and downloads the hand-off", () => {
    const checklist = accountantChecklist(ACCOUNTANT);
    expect(checklist.role).toBe("accountant");
    expect(checklist.title).toBe("Get started as an accountant");
    expect(titles(checklist)).toEqual([
      "Open the accountant console",
      "Open one workspace's queue",
      "Book one payment or apply one receipt",
      "Download the month's hand-off",
    ]);
    expect(checklist.guide).toBe("accountants");
    const steps = Object.fromEntries(checklist.steps.map((step) => [step.id, step]));
    expect(steps.console.href).toBe("/accountant");
    expect(steps.queue.href).toBe("/accountant?workspace=harbor-bakery");
    expect(steps.book.path).toBe("/invoices?tab=receivables");
    expect(steps.handoff).toMatchObject({ href: "/api/accountant/handoff?org=harbor-bakery&format=csv", download: true });
  });

  it("opens the bookings review when a payment waits for this accountant to book", () => {
    const book = accountantChecklist({ ...ACCOUNTANT, bookHref: "/invoices?review=book-xero" }).steps.find((step) => step.id === "book");
    expect(book).toMatchObject({ path: "/invoices?review=book-xero", needs: "accounting.book" });
    expect(accountantChecklist(ACCOUNTANT).steps.find((step) => step.id === "book")?.needs).toBe("receivables.reconcile");
  });

  it("ticks each step from what happened: the console and a queue opened, a booking or a receipt, a hand-off", () => {
    expect(done(accountantChecklist({ ...ACCOUNTANT, consoleOpened: true }))).toEqual({ console: true, queue: false, book: false, handoff: false });
    expect(done(accountantChecklist({ ...ACCOUNTANT, booked: true })).book).toBe(true);
    expect(done(accountantChecklist({ ...ACCOUNTANT, applied: true })).book).toBe(true);
    expect(done(accountantChecklist({ ...ACCOUNTANT, handedOff: true })).handoff).toBe(true);
    const all = accountantChecklist({ ...ACCOUNTANT, consoleOpened: true, queueOpened: true, applied: true, handedOff: true });
    expect(all.show).toBe(false);
    expect(all.next).toBeNull();
  });

  it("hides for good once dismissed", () => {
    expect(accountantChecklist({ ...ACCOUNTANT, dismissed: true }).show).toBe(false);
  });

  it("offers Invite a client as an optional last step where client links work, done once one of them is used (accountant client links AC6)", () => {
    expect(accountantChecklist(ACCOUNTANT).steps.map((step) => step.id)).not.toContain("invite_client");
    const offered = accountantChecklist({ ...ACCOUNTANT, clientInvited: false });
    const invite = offered.steps.at(-1);
    expect(invite).toMatchObject({ id: "invite_client", title: "Invite a client", href: "/accountant#invite-client-title", optional: true, done: false, needs: null });
    expect(accountantChecklist({ ...ACCOUNTANT, clientInvited: true }).steps.at(-1)?.done).toBe(true);
    // Optional: it is never the next step, and the checklist is done without it.
    expect(offered.next).toBe("console");
    const rest = accountantChecklist({ ...ACCOUNTANT, consoleOpened: true, queueOpened: true, applied: true, handedOff: true, clientInvited: false });
    expect(rest.show).toBe(false);
    expect(rest.next).toBeNull();
  });
});
