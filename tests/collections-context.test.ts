import { describe, expect, it } from "vitest";
import type { SentReminder } from "@/lib/collections";
import {
  defaultPolicy,
  holdDayAllowed,
  outcomeWords,
  policyWords,
  proposeNextAction,
  taskOutcomes,
  taskStillNeeded,
  type CollectionPolicy,
  type CollectionTask,
  type CustomerSaid,
  type ReceivableFacts,
} from "@/lib/collection-context/model";

/**
 * The next action for a receivable from its customer's context (docs/superpowers/specs/2026-10-13-collections-context-design.md
 * C1–C6): wait, ask the account owner, remind (with a tone), or escalate to finance, with the facts it rests on. A
 * dispute, a claim of payment, a promise not yet due and a hold block every reminder; a broken promise goes to finance.
 */

const NOW = Date.parse("2026-10-20T09:00:00Z");
const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
const OWNER = "u0000000-0000-4000-8000-000000000001";

function facts(over: Partial<ReceivableFacts> = {}): ReceivableFacts {
  return {
    invoiceId: "i0000000-0000-4000-8000-000000000001",
    customerId: CUSTOMER,
    customerName: "Acme",
    billingEmail: true,
    amount: 1000,
    currency: "USDC",
    // Five days overdue.
    dueDate: "2026-10-15",
    status: "pending",
    owed: 1000,
    received: 0,
    remindersOn: true,
    payLink: true,
    deferredUntil: null,
    sent: [],
    said: [],
    policy: defaultPolicy(CUSTOMER),
    crm: null,
    tasks: [],
    ...over,
  };
}

const said = (over: Partial<CustomerSaid>): CustomerSaid => ({
  id: "r0000000-0000-4000-8000-000000000001",
  kind: "dispute",
  status: "open",
  outcome: null,
  promisedOn: null,
  paidOn: null,
  createdAt: "2026-10-16T10:00:00Z",
  closedAt: null,
  ...over,
});

const reminder = (number: number, sentAt: string, tone: SentReminder["tone"] = "friendly"): SentReminder => ({ number, tone, sentAt });

const policy = (over: Partial<CollectionPolicy> = {}): CollectionPolicy => ({ ...defaultPolicy(CUSTOMER), id: "p-1", version: 2, createdAt: "2026-10-01T00:00:00Z", ...over });

const task = (over: Partial<CollectionTask>): CollectionTask => ({
  id: "t0000000-0000-4000-8000-000000000001",
  invoiceId: "i0000000-0000-4000-8000-000000000001",
  counterpartyId: CUSTOMER,
  kind: "ask_owner",
  reason: "policy_ask_first",
  subjectKey: "policy:2:reminder:1",
  assignee: OWNER,
  policyVersion: 2,
  proposal: { headline: "", reasons: [], reminder: null },
  status: "open",
  outcome: null,
  holdUntil: null,
  approvedNumber: null,
  approvedTone: null,
  resolvedAt: null,
  resolvedBy: null,
  notifiedAt: null,
  createdAt: "2026-10-19T09:00:00Z",
  ...over,
});

const codes = (proposal: ReturnType<typeof proposeNextAction>) => proposal.reasons.map((reason) => reason.code);

describe("the next action (C1–C6)", () => {
  it("overdue: reminds the customer firmly, and says why", () => {
    const proposal = proposeNextAction(facts(), NOW);
    expect(proposal).toMatchObject({ action: "remind", sends: "agent", heldBy: null, need: null, reminder: { number: 1, tone: "firm", channel: "email", daysFromDue: 5 } });
    expect(proposal.headline).toBe("Remind Acme (firm)");
    expect(proposal.reasons[0]).toEqual({ code: "overdue", text: "5 days overdue: due Oct 15, 2026, 1,000.00 USDC still owed." });
    expect(codes(proposal)).toContain("schedule");
  });

  it("VIP (ask first): asks the account owner with the drafted reminder, and sends it only once approved under these rules", () => {
    const vip = policy({ approval: "ask_first", accountOwner: OWNER });
    const asking = proposeNextAction(facts({ policy: vip }), NOW);
    expect(asking).toMatchObject({ action: "ask_owner", sends: null, reminder: { number: 1, tone: "firm" } });
    expect(asking.need).toEqual({ kind: "ask_owner", reason: "policy_ask_first", subjectKey: "policy:2:reminder:1", assignee: OWNER });
    expect(asking.reasons.find((reason) => reason.code === "policy")?.text).toBe(
      "Rules for Acme, version 2: ask first before any reminder; any tone; at least 3 days apart; by email."
    );

    const open = task({});
    expect(proposeNextAction(facts({ policy: vip, tasks: [open] }), NOW)).toMatchObject({ action: "ask_owner", need: { subjectKey: "policy:2:reminder:1" }, openTask: open });

    const approved = task({ status: "done", outcome: "approved", approvedNumber: 1, approvedTone: "friendly", resolvedAt: "2026-10-19T12:00:00Z", resolvedBy: OWNER });
    const sending = proposeNextAction(facts({ policy: vip, tasks: [approved] }), NOW);
    expect(sending).toMatchObject({ action: "remind", sends: "approved", approvedTask: approved, reminder: { number: 1, tone: "friendly" } });
    expect(codes(sending)).toContain("approved");

    // Rules changed after the approval: the approval no longer covers it, and a new ask is needed.
    const newer = policy({ approval: "ask_first", accountOwner: OWNER, version: 3 });
    expect(proposeNextAction(facts({ policy: newer, tasks: [approved] }), NOW)).toMatchObject({ action: "ask_owner", need: { subjectKey: "policy:3:reminder:1" } });
  });

  it("dispute open: waits, held by the dispute, and opens no task", () => {
    const proposal = proposeNextAction(facts({ said: [said({ kind: "dispute" })] }), NOW);
    expect(proposal).toMatchObject({ action: "wait", heldBy: "dispute", reminder: null, need: null, sends: null });
    expect(proposal.headline).toBe("Wait: the customer disputes it");
  });

  it("dispute resolved: reminds again, and says when it was resolved", () => {
    const proposal = proposeNextAction(facts({ said: [said({ kind: "dispute", status: "closed", outcome: "resolved", closedAt: "2026-10-18T08:00:00Z" })] }), NOW);
    expect(proposal).toMatchObject({ action: "remind", sends: "agent", heldBy: null });
    expect(proposal.reasons.find((reason) => reason.code === "dispute_resolved")?.text).toBe("The customer's dispute was resolved on Oct 18, 2026.");
  });

  it("promise active: waits through the promised day", () => {
    const proposal = proposeNextAction(facts({ said: [said({ kind: "promise", promisedOn: "2026-10-20" })] }), NOW);
    expect(proposal).toMatchObject({ action: "wait", heldBy: "promise", waitUntil: "2026-10-20", need: null });
  });

  it("promise expired: escalates to finance with a review task, never an automatic reminder", () => {
    const promise = said({ id: "r-promise", kind: "promise", promisedOn: "2026-10-19" });
    const proposal = proposeNextAction(facts({ said: [promise] }), NOW);
    expect(proposal).toMatchObject({ action: "escalate", heldBy: "promise_passed", reminder: null, sends: null });
    expect(proposal.need).toEqual({ kind: "finance_review", reason: "promise_passed", subjectKey: "promise:r-promise", assignee: null });
    expect(proposal.reasons.at(-1)?.text).toBe("The customer promised to pay by Oct 19, 2026, and that day passed with 1,000.00 USDC still owed. Finance reviews it before any reminder.");
  });

  it("part paid: reminds of what is still owed, saying what arrived", () => {
    const proposal = proposeNextAction(facts({ owed: 600, received: 400 }), NOW);
    expect(proposal).toMatchObject({ action: "remind", reminder: { owed: 600, received: 400 } });
    expect(proposal.reasons.find((reason) => reason.code === "part_paid")?.text).toBe("Part paid: 400.00 USDC of 1,000.00 USDC arrived.");
  });

  it("paid: no action", () => {
    expect(proposeNextAction(facts({ status: "received" }), NOW)).toMatchObject({ action: "none", headline: "Paid: nothing to collect", need: null });
    expect(proposeNextAction(facts({ owed: 0, received: 1000 }), NOW)).toMatchObject({ action: "none", headline: "Nothing owed" });
  });

  it('"I paid" claim pending: waits for the payment to be verified', () => {
    const proposal = proposeNextAction(facts({ said: [said({ kind: "paid", paidOn: "2026-10-18" })] }), NOW);
    expect(proposal).toMatchObject({ action: "wait", heldBy: "paid_claim", need: null });
    expect(proposal.reasons.at(-1)?.text).toBe(
      "The customer says it paid on Oct 18, 2026. Reminders wait until you find the payment or mark it not received; finance is asked to check it on Oct 24, 2026 if it is still open."
    );
  });

  it('"I paid" claim nobody checked for a week: finance reviews it, and reminders wait for that person, never for ever on the claim alone', () => {
    const claim = said({ id: "r-claim", kind: "paid", paidOn: "2026-10-10", createdAt: "2026-10-12T10:00:00Z" });
    const proposal = proposeNextAction(facts({ said: [claim] }), NOW);
    expect(proposal).toMatchObject({ action: "escalate", heldBy: "paid_claim", reminder: null, sends: null });
    expect(proposal.headline).toBe("Escalate to finance: a payment to verify");
    expect(proposal.need).toEqual({ kind: "finance_review", reason: "claim_unverified", subjectKey: "claim:r-claim", assignee: null });
    expect(proposal.reasons.at(-1)?.text).toBe(
      "The customer said on Oct 12, 2026 that it paid on Oct 10, 2026, and the payment is still not found after 7 days. Finance finds it or marks it not received before any reminder."
    );
    // Seven whole days after the day it was made, it still only waits.
    expect(proposeNextAction(facts({ said: [{ ...claim, createdAt: "2026-10-13T23:00:00Z" }] }), NOW)).toMatchObject({ action: "wait", heldBy: "paid_claim", need: null });
    // A review open already is the one asked; a dispute still outranks the claim.
    const open = task({ kind: "finance_review", reason: "claim_unverified", subjectKey: "claim:r-claim", assignee: null });
    expect(proposeNextAction(facts({ said: [claim], tasks: [open] }), NOW)).toMatchObject({ action: "escalate", openTask: open });
    expect(proposeNextAction(facts({ said: [claim, said({ id: "d", kind: "dispute" })] }), NOW)).toMatchObject({ action: "wait", heldBy: "dispute" });
  });

  it("stale (no billing email): escalates to finance, or asks the account owner when the rules name one", () => {
    const toFinance = proposeNextAction(facts({ billingEmail: false }), NOW);
    expect(toFinance).toMatchObject({ action: "escalate", need: { kind: "finance_review", reason: "no_contact", subjectKey: "no_contact" } });
    const toOwner = proposeNextAction(facts({ billingEmail: false, policy: policy({ accountOwner: OWNER }) }), NOW);
    expect(toOwner).toMatchObject({ action: "ask_owner", need: { kind: "ask_owner", reason: "no_contact", assignee: OWNER } });
    // Reminders off, or not due yet: said, but nobody is asked.
    expect(proposeNextAction(facts({ billingEmail: false, remindersOn: false }), NOW).need).toBeNull();
    expect(proposeNextAction(facts({ billingEmail: false, dueDate: "2026-10-22" }), NOW).need).toBeNull();
  });

  it("HubSpot deal with an owner: asks before the first overdue reminder, then reminds as usual", () => {
    const crm = { provider: "hubspot" as const, dealExternalId: "9001", dealName: "Website rebuild", ownerId: "77", url: null };
    const asking = proposeNextAction(facts({ crm }), NOW);
    expect(asking).toMatchObject({ action: "ask_owner", need: { kind: "ask_owner", reason: "hubspot_owner", subjectKey: "hubspot:9001" }, reminder: { number: 1, tone: "firm" } });
    expect(asking.reasons.find((reason) => reason.code === "hubspot_owner")?.text).toContain("From the HubSpot deal Website rebuild, which has an owner");
    // Before the due date, and once an overdue reminder went, nothing is asked.
    expect(proposeNextAction(facts({ crm, dueDate: "2026-10-21" }), NOW).action).toBe("remind");
    expect(proposeNextAction(facts({ crm, sent: [reminder(1, "2026-10-16T09:00:00Z", "firm")] }), NOW).action).toBe("remind");
    // No owner in HubSpot: nothing to ask.
    expect(proposeNextAction(facts({ crm: { ...crm, ownerId: null } }), NOW).action).toBe("remind");
    // Sales gave more time: held until then, and after it reminders go without asking again.
    const held = task({ reason: "hubspot_owner", subjectKey: "hubspot:9001", status: "done", outcome: "held", holdUntil: "2026-10-25", resolvedAt: "2026-10-19T10:00:00Z" });
    expect(proposeNextAction(facts({ crm, tasks: [held] }), NOW)).toMatchObject({ action: "wait", heldBy: "hold", waitUntil: "2026-10-25" });
    expect(proposeNextAction(facts({ crm, tasks: [held] }), Date.parse("2026-10-26T09:00:00Z"))).toMatchObject({ action: "remind", sends: "agent" });
  });

  it("caps the tone and spaces reminders by the customer's rules", () => {
    const sent = [reminder(1, "2026-10-12T09:00:00Z"), reminder(2, "2026-10-15T09:00:00Z")];
    // 9 days overdue with 2 sent: final is allowed by code, and the schedule asks for firm.
    const late = Date.parse("2026-10-24T09:00:00Z");
    expect(proposeNextAction(facts({ sent }), late).reminder?.tones).toEqual(["friendly", "firm", "final"]);
    expect(proposeNextAction(facts({ sent, policy: policy({ maxTone: "friendly" }) }), late).reminder).toMatchObject({ tone: "friendly", tones: ["friendly"] });
    const spaced = proposeNextAction(facts({ sent, policy: policy({ minDaysBetween: 14 }) }), late);
    expect(spaced).toMatchObject({ action: "wait", waitUntil: "2026-10-29" });
    expect(spaced.reasons.at(-1)?.text).toBe("No reminder yet: a reminder went out less than 14 days ago. The next can go on Oct 29, 2026.");
  });

  it("reminders done: escalates to finance once, then leaves the follow-up to a person", () => {
    const sent = [reminder(1, "2026-10-12T09:00:00Z"), reminder(2, "2026-10-15T09:00:00Z", "firm"), reminder(3, "2026-10-18T09:00:00Z", "final")];
    expect(proposeNextAction(facts({ sent }), NOW)).toMatchObject({ action: "escalate", need: { kind: "finance_review", reason: "reminders_done" } });
    const reviewed = task({ kind: "finance_review", reason: "reminders_done", subjectKey: "reminders_done", status: "done", outcome: "done", resolvedAt: "2026-10-19T09:00:00Z" });
    expect(proposeNextAction(facts({ sent, tasks: [reviewed] }), NOW)).toMatchObject({ action: "wait", headline: "Follow up with the customer yourself", need: null });
    // An old receivable the agent never reminded: said, never a task.
    expect(proposeNextAction(facts({ dueDate: "2026-09-01" }), NOW)).toMatchObject({ action: "escalate", need: null });
  });

  it("reminders off or no pay link: proposes the reminder, which waits for a person to turn them on", () => {
    expect(proposeNextAction(facts({ remindersOn: false }), NOW)).toMatchObject({ action: "remind", sends: "off", need: null });
    expect(proposeNextAction(facts({ payLink: false }), NOW)).toMatchObject({ action: "remind", sends: "off" });
    // Ask-first rules ask nobody while reminders are off.
    expect(proposeNextAction(facts({ remindersOn: false, policy: policy({ approval: "ask_first" }) }), NOW)).toMatchObject({ action: "remind", sends: "off", need: null });
  });

  it("not due yet: waits until 3 days before the due date", () => {
    expect(proposeNextAction(facts({ dueDate: "2026-10-30" }), NOW)).toMatchObject({ action: "wait", waitUntil: "2026-10-27" });
  });

  it("a dispute outranks a claim, a claim outranks a promise", () => {
    const all = [said({ kind: "promise", id: "p", promisedOn: "2026-10-10" }), said({ kind: "paid", id: "c", paidOn: "2026-10-18" }), said({ kind: "dispute", id: "d" })];
    expect(proposeNextAction(facts({ said: all }), NOW).heldBy).toBe("dispute");
    expect(proposeNextAction(facts({ said: all.slice(0, 2) }), NOW).heldBy).toBe("paid_claim");
  });
});

describe("which open tasks are still needed (C6)", () => {
  const needed = (task: CollectionTask, over: Partial<ReceivableFacts> = {}) => {
    const all = facts(over);
    return taskStillNeeded(task, all, proposeNextAction(all, NOW));
  };

  it("keeps a broken promise's task while the promise is open, even under a dispute, and drops it once the promise is closed", () => {
    const promise = said({ id: "r-promise", kind: "promise", promisedOn: "2026-10-19" });
    const review = task({ kind: "finance_review", reason: "promise_passed", subjectKey: "promise:r-promise" });
    expect(needed(review, { said: [promise] })).toBe(true);
    expect(needed(review, { said: [promise, said({ id: "r-dispute", kind: "dispute" })] })).toBe(true);
    expect(needed(review, { said: [{ ...promise, status: "closed", outcome: "resolved", closedAt: "2026-10-20T08:00:00Z" }] })).toBe(false);
  });

  it("drops an ask-first task once the rules or the drafted reminder changed, a contact task once there is an email, and every task once paid", () => {
    const vip = policy({ approval: "ask_first" });
    expect(needed(task({}), { policy: vip })).toBe(true);
    expect(needed(task({}), { policy: policy({ approval: "auto" }) })).toBe(false);
    expect(needed(task({}), { policy: policy({ approval: "ask_first", version: 3 }) })).toBe(false);
    expect(needed(task({}), { policy: vip, sent: [reminder(1, "2026-10-16T09:00:00Z", "firm")] })).toBe(false);
    const contact = task({ kind: "finance_review", reason: "no_contact", subjectKey: "no_contact" });
    expect(needed(contact, { billingEmail: false })).toBe(true);
    expect(needed(contact, { billingEmail: true })).toBe(false);
    expect(needed(task({}), { policy: vip, status: "received" })).toBe(false);
    const hubspot = task({ reason: "hubspot_owner", subjectKey: "hubspot:9001" });
    expect(needed(hubspot)).toBe(true);
    expect(needed(hubspot, { sent: [reminder(1, "2026-10-16T09:00:00Z", "firm")] })).toBe(false);
  });

  it("keeps a claim's review while the claim is open, and drops it once the payment is found or marked not received", () => {
    const claim = said({ id: "r-claim", kind: "paid", paidOn: "2026-10-10", createdAt: "2026-10-12T10:00:00Z" });
    const review = task({ kind: "finance_review", reason: "claim_unverified", subjectKey: "claim:r-claim" });
    expect(needed(review, { said: [claim] })).toBe(true);
    expect(needed(review, { said: [{ ...claim, status: "closed", outcome: "not_received", closedAt: "2026-10-20T08:00:00Z" }] })).toBe(false);
  });
});

describe("tasks only from the day they began in the workspace (C6, at launch)", () => {
  // Tasks began here two days before NOW: what was already so then is shown, and asks nobody.
  const START = "2026-10-18";
  const stale = (proposal: ReturnType<typeof proposeNextAction>) => codes(proposal).includes("before_tasks");

  it("a promise broken before tasks began opens none, still holds reminders, and says so; one whose day is on or after the start opens one", () => {
    const old = proposeNextAction(facts({ tasksFrom: START, said: [said({ id: "p-old", kind: "promise", promisedOn: "2026-10-17" })] }), NOW);
    expect(old).toMatchObject({ action: "escalate", heldBy: "promise_passed", need: null, openTask: null });
    expect(stale(old)).toBe(true);
    const fresh = proposeNextAction(facts({ tasksFrom: START, said: [said({ id: "p-new", kind: "promise", promisedOn: "2026-10-18" })] }), NOW);
    expect(fresh.need).toMatchObject({ reason: "promise_passed", subjectKey: "promise:p-new" });
    expect(stale(fresh)).toBe(false);
  });

  it("a claim, reminders done and a missing contact already so before the start open none", () => {
    const claim = said({ id: "c-old", kind: "paid", paidOn: "2026-10-01", createdAt: "2026-10-02T10:00:00Z" });
    expect(proposeNextAction(facts({ tasksFrom: START, said: [claim] }), NOW)).toMatchObject({ action: "escalate", need: null });
    const done = [reminder(1, "2026-10-12T09:00:00Z"), reminder(2, "2026-10-15T09:00:00Z", "firm"), reminder(3, "2026-10-17T09:00:00Z", "final")];
    expect(proposeNextAction(facts({ tasksFrom: START, sent: done }), NOW)).toMatchObject({ action: "escalate", need: null });
    // The final reminder went on the start day: a task.
    const doneLater = [...done.slice(0, 2), reminder(3, "2026-10-18T09:00:00Z", "final")];
    expect(proposeNextAction(facts({ tasksFrom: START, sent: doneLater }), NOW).need).toMatchObject({ reason: "reminders_done" });
    expect(proposeNextAction(facts({ tasksFrom: START, billingEmail: false }), NOW)).toMatchObject({ action: "escalate", need: null });
    expect(proposeNextAction(facts({ tasksFrom: START, billingEmail: false, dueDate: "2026-10-18" }), NOW).need).toMatchObject({ reason: "no_contact" });
  });

  it("a HubSpot receivable already overdue before the start is not held for its deal's owner: it is reminded as before", () => {
    const crm = { provider: "hubspot" as const, dealExternalId: "9001", dealName: "Website rebuild", ownerId: "77", url: null };
    expect(proposeNextAction(facts({ tasksFrom: START, crm }), NOW)).toMatchObject({ action: "remind", sends: "agent", need: null });
    expect(proposeNextAction(facts({ tasksFrom: START, crm, dueDate: "2026-10-18" }), NOW).need).toMatchObject({ reason: "hubspot_owner" });
  });

  it("keeps a task opened before, whatever its day", () => {
    const review = task({ kind: "finance_review", reason: "promise_passed", subjectKey: "promise:p-old" });
    expect(proposeNextAction(facts({ tasksFrom: START, said: [said({ id: "p-old", kind: "promise", promisedOn: "2026-10-01" })], tasks: [review] }), NOW)).toMatchObject({
      action: "escalate",
      openTask: review,
    });
  });
});

describe("tasks and rules in words", () => {
  it("offers the outcomes each task allows", () => {
    expect(taskOutcomes({ kind: "ask_owner", reason: "policy_ask_first" })).toEqual(["approved", "held", "no_reminder"]);
    expect(taskOutcomes({ kind: "finance_review", reason: "promise_passed" })).toEqual(["resumed", "held"]);
    expect(taskOutcomes({ kind: "finance_review", reason: "reminders_done" })).toEqual(["done"]);
    expect(taskOutcomes({ kind: "finance_review", reason: "claim_unverified" })).toEqual(["resumed", "held"]);
  });

  it("says a resolution and the rules plainly", () => {
    expect(outcomeWords({ outcome: "held", holdUntil: "2026-10-25", approvedNumber: null, approvedTone: null })).toBe("Reminders held until Oct 25, 2026.");
    expect(outcomeWords({ outcome: "approved", holdUntil: null, approvedNumber: 2, approvedTone: "firm" })).toBe("Approved reminder 2, firm.");
    expect(policyWords(defaultPolicy(CUSTOMER), "Acme")).toBe("Acme has no rules of its own: reminders follow the workspace's schedule.");
    expect(policyWords(policy({ maxTone: "firm", minDaysBetween: 7 }), "Acme")).toBe("Rules for Acme, version 2: reminders go on their own; at most firm; at least 7 days apart; by email.");
  });

  it("takes a hold from tomorrow up to 60 days ahead", () => {
    expect(holdDayAllowed("2026-10-21", "2026-10-20")).toBe(true);
    expect(holdDayAllowed("2026-12-19", "2026-10-20")).toBe(true);
    expect(holdDayAllowed("2026-12-20", "2026-10-20")).toBe(false);
    expect(holdDayAllowed("2026-10-20", "2026-10-20")).toBe(false);
    expect(holdDayAllowed("2026-02-30", "2026-01-20")).toBe(false);
    expect(holdDayAllowed("soon", "2026-10-20")).toBe(false);
  });
});
