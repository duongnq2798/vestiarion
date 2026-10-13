import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTION_INVOICES, COLLECTION_SHOTS, COLLECTIONS_NOW, collectionsShot } from "@/app/docs-shots/collections-fixture";
import { CollectionsPanel } from "@/components/collections/CollectionsPanel";
import { NextAction } from "@/components/collections/NextAction";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { buildCollections, inCollections } from "@/lib/collection-context/page";
import { maskAddress, promiseRecord } from "@/lib/collection-context/view";

/**
 * Collections on the Receivables tab (docs/superpowers/specs/2026-10-13-collections-context-design.md C8): the panel's
 * figures and the receivables to look at first; a receivable's next step, why, the reminder exactly as the customer
 * reads it, its task and its customer's rules; and the actions, which authorize first, hand the form to the commands
 * and start a cycle only for an approval.
 */

const { authorizeMock, raiseMock, commands } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  raiseMock: vi.fn(),
  commands: { policy: vi.fn(), resolve: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/commands/collections", () => ({ setCollectionPolicy: commands.policy, resolveCollectionTaskCommand: commands.resolve }));

import { resolveCollectionTaskAction, setCollectionPolicyAction } from "@/app/actions/collections";

const href = (id: string) => `/o/northstar/invoices?tab=receivables&open=${id}`;
const shot = collectionsShot(href);
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "u1", email: null }, membership: { orgId: "org-1", slug: "northstar", role: "owner", mode: "live" } });
  raiseMock.mockReset();
  commands.policy.mockReset();
  commands.resolve.mockReset();
});

describe("the Collections panel", () => {
  it("counts what waits on a person, the reminders this week and promises kept and broken, then lists a person's steps first", () => {
    expect(shot.panel).toMatchObject({ waiting: 4, sentThisWeek: 4, promises: { kept: 3, broken: 1 } });
    expect(shot.panel.items.map((item) => item.action)).toEqual(["escalate", "escalate", "ask_owner", "ask_owner", "remind", "remind"]);
    const markup = render(<CollectionsPanel panel={shot.panel} available />);
    expect(markup).toContain("Collections");
    expect(markup).toContain("Waiting on you");
    expect(markup).toContain("Reminders sent");
    expect(markup).toContain("3 · 1");
    expect(markup).toContain("Review a broken promise: open it");
    expect(markup).toContain(`href="${href(COLLECTION_SHOTS.promise).replace("&", "&amp;")}"`);
    expect(markup).toContain("640.00 USDC owed · Due Oct 8, 2026");
    expect(markup).toContain("And 2 more in the list below.");
    expect(markup).not.toContain("not set up");
  });

  it("says when nothing needs chasing, and when rules are not set up", () => {
    const markup = render(<CollectionsPanel panel={{ waiting: 0, sentThisWeek: 0, promises: { kept: 0, broken: 0 }, items: [], more: 0 }} available={false} />);
    expect(markup).toContain("Nothing to chase");
    expect(markup).toContain("Customer rules and tasks are not set up on this deployment yet");
  });

  it("proposes the receivables due within a week, the overdue ones, those opened and those with a task", () => {
    const today = new Date(COLLECTIONS_NOW).toISOString().slice(0, 10);
    const later = { ...COLLECTION_INVOICES[0], id: "later", due_date: "2026-12-01T00:00:00Z" };
    expect(inCollections([...COLLECTION_INVOICES, later], today, [], new Set()).map((invoice) => invoice.id)).not.toContain("later");
    expect(inCollections([later], today, ["later"], new Set())).toHaveLength(1);
    expect(inCollections([later], today, [], new Set(["later"]))).toHaveLength(1);
    // Paid ones never.
    expect(inCollections(COLLECTION_INVOICES, today, [], new Set()).every((invoice) => invoice.status === "pending")).toBe(true);
  });
});

describe("a receivable's next step", () => {
  const vip = shot.views.get(COLLECTION_SHOTS.vip)!;

  it("says the step, why, and previews the reminder exactly as the customer reads it, its address mostly hidden", () => {
    expect(vip).toMatchObject({ action: "ask_owner", actionLabel: "Ask the account owner", headline: "Ask the account owner before reminding" });
    expect(vip.preview).toMatchObject({ channel: "Email", to: "ap***@acme.example", tone: "firm", subject: "Reminder: 1,800.00 USDC to Northstar Studio was due Oct 15, 2026" });
    expect(vip.preview?.text).toContain("Pay on Arc testnet: https://www.vestiarion.xyz/pay/acme-1042");
    const markup = render(<NextAction orgSlug="northstar" view={vip} canWrite rulesAvailable open={["preview"]} />);
    expect(markup).toContain("Why");
    expect(markup).toContain("5 days overdue: due Oct 15, 2026, 1,800.00 USDC still owed.");
    expect(markup).toContain("Rules for Acme Retail, version 2: ask first before any reminder; at most firm; at least 7 days apart; by email.");
    expect(markup).toContain("Preview the reminder");
    expect(markup).toContain("Approve a reminder");
    expect(markup).toContain("Asks ana@northstar.example");
    for (const label of ["Send this reminder", "Hold reminders", "No reminders for this invoice", "Save rules"]) expect(markup).toContain(label);
  });

  it("shows a member who cannot write the same step and rules, without the forms", () => {
    const markup = render(<NextAction orgSlug="northstar" view={vip} canWrite={false} rulesAvailable />);
    expect(markup).toContain("An owner or admin answers it.");
    expect(markup).toContain("An owner or admin sets a customer&#x27;s rules.");
    expect(markup).not.toContain("Send this reminder");
    expect(markup).not.toContain("Save rules");
  });

  it("links a HubSpot deal, and says a broken promise goes to finance", () => {
    const hubspot = shot.views.get(COLLECTION_SHOTS.hubspot)!;
    expect(hubspot.crm).toEqual({ name: "Website rebuild", url: "https://app.hubspot.com/contacts/48291736/record/0-3/30117482911", hasOwner: true });
    expect(render(<NextAction orgSlug="northstar" view={hubspot} canWrite rulesAvailable />)).toContain("Open the deal in HubSpot");
    const promise = shot.views.get(COLLECTION_SHOTS.promise)!;
    expect(promise).toMatchObject({ action: "escalate", preview: null, task: { label: "Review a broken promise", outcomes: [{ value: "resumed" }, { value: "held" }] } });
  });

  it("shows a promise broken before tasks began here as the stage sees it: held for finance, with no task and nobody emailed", () => {
    const bluebird = COLLECTION_INVOICES[1];
    const view = buildCollections({
      orgName: "Northstar Studio",
      network: "arc-testnet",
      origin: "https://www.vestiarion.xyz",
      now: COLLECTIONS_NOW,
      invoices: [bluebird],
      billingEmails: new Map([[bluebird.counterparty_id, "ap@bluebird.example"]]),
      owed: (invoice) => ({ owed: invoice.amount, received: 0 }),
      links: new Map(),
      said: new Map([[bluebird.id, [{ id: "p-1", kind: "promise", status: "open", outcome: null, promisedOn: "2026-10-16", paidOn: null, createdAt: "2026-10-09T07:55:00Z", closedAt: null }]]]),
      policies: { available: true, latest: new Map() },
      tasks: [],
      crm: new Map(),
      members: [],
      focus: [],
      sentThisWeek: 0,
      promises: [],
      href,
      tasksFrom: "2026-10-18",
    }).views.get(bluebird.id)!;
    expect(view).toMatchObject({ action: "escalate", task: null });
    expect(view.reasons).toContain("This was already so before the agent began asking people here on Oct 18, 2026: no task was opened and nobody was emailed.");
  });

  it("hides most of an address", () => {
    expect(maskAddress("billing@acme.example")).toBe("bi***@acme.example");
    expect(maskAddress("a@b.example")).toBe("a***@b.example");
    expect(maskAddress("nonsense")).toBe("***");
  });

  it("counts a promise kept when paid by its day, broken when its day passed unpaid or paid late, and leaves out one replaced", () => {
    expect(
      promiseRecord(
        [
          { promisedOn: "2026-10-10", outcome: "resolved", settledAt: "2026-10-10T20:00:00Z" },
          { promisedOn: "2026-10-10", outcome: null, settledAt: "2026-10-12T09:00:00Z" },
          { promisedOn: "2026-10-15", outcome: null, settledAt: null },
          { promisedOn: "2026-10-25", outcome: null, settledAt: null },
          { promisedOn: "2026-10-12", outcome: "superseded", settledAt: null },
          { promisedOn: "2026-06-01", outcome: null, settledAt: null },
        ],
        "2026-10-20"
      )
    ).toEqual({ kept: 1, broken: 2 });
  });
});

describe("the actions", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({ orgSlug: "northstar", ...fields })) data.set(key, value);
    return data;
  };
  const TASK = "00000000-0000-4000-8000-000000006401";
  const CUSTOMER = "00000000-0000-4000-8000-000000001301";

  it("authorize records.write first, and refuse anyone else before a command runs", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    expect(await resolveCollectionTaskAction({ ok: false, message: "" }, form({ taskId: TASK, outcome: "approved" }))).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(commands.resolve).not.toHaveBeenCalled();
  });

  it("start a cycle for an approval, and not for a hold", async () => {
    commands.resolve.mockResolvedValueOnce({ ok: true, message: "Approved.", startsCycle: true });
    expect(await resolveCollectionTaskAction({ ok: false, message: "" }, form({ taskId: TASK, outcome: "approved", tone: "firm" }))).toEqual({ ok: true, message: "Approved." });
    expect(commands.resolve).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), { taskId: TASK, outcome: "approved", tone: "firm", holdUntil: null });
    expect(raiseMock).toHaveBeenCalledWith(expect.anything(), "reminder_approved");
    raiseMock.mockReset();
    commands.resolve.mockResolvedValueOnce({ ok: true, message: "Held.", startsCycle: false });
    await resolveCollectionTaskAction({ ok: false, message: "" }, form({ taskId: TASK, outcome: "held", holdUntil: "2026-10-30" }));
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("hand the rules to the command, the owners and admins meaning no one named", async () => {
    commands.policy.mockResolvedValueOnce({ ok: true, message: "Saved.", version: 3 });
    await setCollectionPolicyAction(
      { ok: false, message: "" },
      form({ counterpartyId: CUSTOMER, approval: "ask_first", maxTone: "firm", minDaysBetween: "7", accountOwner: "owners", expectedVersion: "2" })
    );
    expect(commands.policy).toHaveBeenCalledWith(expect.anything(), {
      counterpartyId: CUSTOMER,
      approval: "ask_first",
      maxTone: "firm",
      minDaysBetween: 7,
      accountOwner: null,
      expectedVersion: 2,
    });
    expect(await setCollectionPolicyAction({ ok: false, message: "" }, form({ counterpartyId: CUSTOMER, accountOwner: "someone" }))).toEqual({ ok: false, message: "Choose the account owner from the list." });
    expect(await setCollectionPolicyAction({ ok: false, message: "" }, form({ counterpartyId: "nope" }))).toEqual({ ok: false, message: "That is not one of this workspace's." });
  });
});
