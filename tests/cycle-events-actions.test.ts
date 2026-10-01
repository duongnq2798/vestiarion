import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { returnInvoiceAction } from "@/app/actions/approvals";
import { resumeAgentAction } from "@/app/actions/agent";
import { confirmCounterpartyAddressAction, createInvoiceAction, importInvoicesAction, updateCounterpartyLimitAction } from "@/app/actions/intake";
import { manualMilestoneVerificationAction } from "@/app/actions/milestones";
import { loadSampleDataAction } from "@/app/actions/sample-data";
import { refreshOnChainBalanceAction } from "@/app/actions/treasury";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The actions that give the agent a decision to make raise a cycle event
 * after they succeed, and only then (event-driven cycles §2). The event
 * itself is faked — tests/cycle-soon.test.ts covers what it does — and so are
 * authorization, the libraries each action calls and the ledger; the actions
 * that write rows directly write them to a recorded supabase-js client.
 */

const { ORG, USER, raiseMock, authorizeMock, mocks } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1",
  raiseMock: vi.fn(),
  authorizeMock: vi.fn(),
  mocks: {
    returnInvoice: vi.fn(),
    resumeAgent: vi.fn(),
    confirmCounterpartyAddress: vi.fn(),
    changeCounterpartyLimit: vi.fn(),
    loadSampleData: vi.fn(),
    refreshOnChainBalances: vi.fn(),
    appendLedgerEntry: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: mocks.appendLedgerEntry }));
vi.mock("@/lib/agent/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/approvals")>()),
  returnInvoice: mocks.returnInvoice,
}));
vi.mock("@/lib/platform/pause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/pause")>()),
  resumeAgent: mocks.resumeAgent,
}));
vi.mock("@/lib/counterparty-address", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counterparty-address")>()),
  confirmCounterpartyAddress: mocks.confirmCounterpartyAddress,
}));
vi.mock("@/lib/counterparty-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counterparty-limit")>()),
  changeCounterpartyLimit: mocks.changeCounterpartyLimit,
}));
vi.mock("@/lib/sample-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sample-data")>()),
  loadSampleData: mocks.loadSampleData,
}));
vi.mock("@/lib/agent/balances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/balances")>()),
  refreshOnChainBalances: mocks.refreshOnChainBalances,
}));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b1";

let fake: ReturnType<typeof fakeSupabase>;

vi.mock("@/lib/dal/scope", () => ({
  inOrg: (_access: unknown, fn: () => Promise<unknown>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn),
}));

const ACCESS = {
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live", role: "owner" },
};

/** The rows these actions read and write, answered the way PostgREST answers. */
function workspace(sent: RecordedRequest) {
  const wantsObject = sent.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
  if (sent.path === "/rest/v1/counterparties") return { body: [{ id: COUNTERPARTY, name: "Acme" }] };
  if (sent.path === "/rest/v1/invoices" && sent.method === "POST") {
    const rows = Array.isArray(sent.body) ? sent.body : [sent.body];
    const inserted = rows.map((_row, index) => ({ id: `${INVOICE.slice(0, -1)}${index}` }));
    return { body: wantsObject ? inserted[0] : inserted };
  }
  if (sent.path === "/rest/v1/milestones" && sent.method === "GET") {
    return { body: [{ id: MILESTONE, title: "Shipped", verified: false, status: "pending", verification_source: null }] };
  }
  return { body: [] };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const invoice = (direction: "payable" | "receivable") =>
  form({ direction, counterpartyId: COUNTERPARTY, amount: "10.50", memo: "Services", poReference: "PO-42", goodsReceived: "on", dueDate: "2026-10-31" });

const csvRow = (direction: string) => ({
  direction, counterparty: "Acme", amount: "5", memo: "", po_reference: "PO-1", goods_received: "yes", due_date: "2026-10-31",
});

const empty = { ok: false, message: "" };

beforeEach(() => {
  fake = fakeSupabase(workspace);
  raiseMock.mockReset();
  authorizeMock.mockReset().mockResolvedValue(ACCESS);
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("adding an invoice", () => {
  it("raises invoice_added for a payable, and says the agent decides within a minute", async () => {
    const result = await createInvoiceAction(empty, invoice("payable"));
    expect(result).toMatchObject({ ok: true, message: "Invoice added for Acme. The agent usually decides on it within a minute." });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "invoice_added");
  });

  it("raises nothing for a receivable, which the agent has nothing to decide about", async () => {
    const result = await createInvoiceAction(empty, invoice("receivable"));
    expect(result).toMatchObject({ ok: true, message: "Invoice added for Acme." });
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("raises nothing when the caller is refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You do not have access to that workspace." });
    await createInvoiceAction(empty, invoice("payable"));
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe("importing invoices", () => {
  it("raises invoice_added once when any row is a payable", async () => {
    const result = await importInvoicesAction(empty, form({ rowsJson: JSON.stringify([csvRow("payable"), csvRow("receivable"), csvRow("payable")]) }));
    expect(result).toMatchObject({ ok: true, created: 3 });
    expect(raiseMock).toHaveBeenCalledTimes(1);
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "invoice_added");
  });

  it("raises nothing when every row is a receivable, or the file does not parse", async () => {
    await importInvoicesAction(empty, form({ rowsJson: JSON.stringify([csvRow("receivable")]) }));
    await importInvoicesAction(empty, form({ rowsJson: "not json" }));
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe("verifying a milestone by hand", () => {
  it("raises milestone_verified when it verifies", async () => {
    const result = await manualMilestoneVerificationAction(empty, form({ milestoneId: MILESTONE, intent: "verify", note: "Shipped and reviewed" }));
    expect(result).toEqual({ ok: true, message: "Manual verification recorded." });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "milestone_verified");
  });

  it("raises nothing when it revokes", async () => {
    await manualMilestoneVerificationAction(empty, form({ milestoneId: MILESTONE, intent: "revoke", note: "Not merged after all" }));
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe("returning a payable to the agent", () => {
  it("raises payable_returned, and says the agent decides it again within a minute", async () => {
    mocks.returnInvoice.mockResolvedValue(undefined);
    const result = await returnInvoiceAction(empty, form({ invoiceId: INVOICE }));
    expect(result).toEqual({ ok: true, message: "Returned to the agent. It usually decides it again within a minute." });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "payable_returned");
  });

  it("raises nothing when the return is refused", async () => {
    mocks.returnInvoice.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await returnInvoiceAction(empty, form({ invoiceId: INVOICE }));
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe("confirming a changed address", () => {
  it("raises address_confirmed when it confirmed one", async () => {
    mocks.confirmCounterpartyAddress.mockResolvedValue(true);
    await confirmCounterpartyAddressAction(empty, form({ counterpartyId: COUNTERPARTY, address: "0xabc" }));
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "address_confirmed");
  });

  it("raises nothing when there was nothing to confirm", async () => {
    mocks.confirmCounterpartyAddress.mockResolvedValue(false);
    await confirmCounterpartyAddressAction(empty, form({ counterpartyId: COUNTERPARTY, address: "0xabc" }));
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe("changing a counterparty's limit", () => {
  const change = (paymentLimit: string) => updateCounterpartyLimitAction(empty, form({ counterpartyId: COUNTERPARTY, paymentLimit }));

  it("raises limit_raised when the limit went up and screening allows some of it, so a held payment is decided again", async () => {
    mocks.changeCounterpartyLimit.mockResolvedValue({ name: "Acme", from: 1, to: 5, current: 5 });
    await change("5");
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "limit_raised");
  });

  it("raises nothing when the limit went down", async () => {
    mocks.changeCounterpartyLimit.mockResolvedValue({ name: "Acme", from: 5, to: 1, current: 1 });
    await change("1");
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("raises nothing when screening allows nothing for the counterparty's risk", async () => {
    mocks.changeCounterpartyLimit.mockResolvedValue({ name: "Acme", from: 1, to: 5, current: 0 });
    await change("5");
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("raises nothing when the change is refused", async () => {
    mocks.changeCounterpartyLimit.mockRejectedValue(new Error("conflict"));
    await change("5").catch(() => undefined);
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe("resuming the agent", () => {
  it("raises agent_resumed", async () => {
    mocks.resumeAgent.mockResolvedValue(undefined);
    const result = await resumeAgentAction({ ok: false, message: "" }, form({}));
    expect(result).toEqual({ ok: true, message: "Agent resumed." });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "agent_resumed");
  });
});

describe("refreshing the balance", () => {
  // A payable held for want of funds is not decided again by a cycle (only pending and
  // matched payables are), so funds arriving gives the agent nothing new to decide.
  it("raises nothing, even when the balance rose", async () => {
    mocks.refreshOnChainBalances.mockResolvedValue({ refreshed: true, balance: 40, syncedAt: "2026-09-30T12:00:00Z" });
    await refreshOnChainBalanceAction("northstar");
    expect(raiseMock).not.toHaveBeenCalled();
  });
});

describe("loading sample data", () => {
  it("raises sample_loaded, and says the agent is deciding on them now", async () => {
    mocks.loadSampleData.mockResolvedValue({ counterparties: 6, invoices: 6, milestones: 2 });
    const result = await loadSampleDataAction({ ok: false, message: "" }, form({}));
    expect(result).toEqual({
      ok: true,
      message: "Sample data loaded: 6 counterparties, 6 invoices and 2 milestones. The agent usually decides on them within a minute.",
    });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "sample_loaded");
  });
});
