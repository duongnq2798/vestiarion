import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { forgetPaymentsSwitch } from "@/lib/payments-switch";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Bills & receivables reads its data at once (docs/superpowers/specs/2026-10-22-bills-page-parallel-reads-design.md):
 * every read that waits on nothing but the workspace and the address starts together, a read that waits on another
 * starts the moment that one answers, and a read two parts need is made once.
 *
 * The fake database answers in waves: it holds every request until none has arrived for a moment, then answers them
 * all together. The page's reads therefore land in as many waves as its longest chain of reads that wait on each other,
 * whatever the machine's speed, and a read's wave says what it waited for.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b22";
const USER = "5a1d2c3e-0000-4000-8000-0000000000aa";
const ACCESS = {
  user: { id: USER, email: "owner@harbor.example" },
  membership: { orgId: ORG, slug: "harbor-bakery", name: "Harbor Bakery", mode: "live" as const, role: "owner" as const, network: "arc-testnet" as const },
};

const world = vi.hoisted(() => ({ run: null as null | (<T>(fn: () => Promise<T>) => Promise<T>) }));

vi.mock("@/lib/auth/membership", () => ({ requireMembership: vi.fn(async () => ACCESS) }));
vi.mock("@/lib/auth/authorize", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/authorize")>()), viewerCan: vi.fn(async () => true) }));
vi.mock("@/lib/dal/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal/scope")>()),
  inOrg: (_access: unknown, fn: () => Promise<unknown>) => (world.run as NonNullable<typeof world.run>)(fn),
}));

import InvoicesPage from "@/app/o/[slug]/invoices/page";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const VENDOR = { id: "c0000000-0000-4000-8000-000000000001", name: "Coastal Flour Mill", role: "vendor", address: `0x${"1".repeat(40)}`, payment_limit: null, sample: false };
const CLIENT = { id: "c0000000-0000-4000-8000-000000000002", name: "Bayside Cafe", role: "client", address: `0x${"2".repeat(40)}`, payment_limit: null, sample: false };
const invoice = (id: string, fields: Record<string, unknown>) => ({
  id,
  direction: "payable",
  counterparty_id: VENDOR.id,
  amount: "120.00",
  memo: `INV-${id.slice(-3)}`,
  po_reference: null,
  goods_received: false,
  due_date: "2026-10-28",
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: null,
  currency: "USDC",
  created_by: null,
  created_at: "2026-10-20T08:00:00Z",
  counterparties: { name: VENDOR.name },
  ...fields,
});
// A bill waiting for a person (its members are read), a paid one with a transaction (its receipt is read), and a
// receivable.
const INVOICES = [
  invoice("a0000000-0000-4000-8000-000000000101", { status: "held" }),
  invoice("a0000000-0000-4000-8000-000000000102", { status: "paid", tx_ref: `0x${"a".repeat(64)}`, due_date: "2026-10-10", paid_amount: "120.00" }),
  invoice("a0000000-0000-4000-8000-000000000103", { direction: "receivable", counterparty_id: CLIENT.id, counterparties: { name: CLIENT.name } }),
];
// A vendor's payment status link: who made it is named from the members, as the waiting bill's owners are.
const SUPPLIER_LINK = { id: "l0000000-0000-4000-8000-000000000201", counterparty_id: VENDOR.id, created_by: USER, created_at: "2026-10-18T08:00:00Z", expires_at: "2026-11-18T08:00:00Z" };

function reply(request: RecordedRequest): FakeReply {
  if (request.method === "HEAD") return { body: [], headers: { "content-range": "*/0" } };
  const select = request.params.get("select") ?? "";
  switch (request.path) {
    case "/rest/v1/invoices":
      return { body: select.startsWith("*,counterparties") ? INVOICES : [] };
    case "/rest/v1/counterparties":
      return { body: [VENDOR, CLIENT] };
    case "/rest/v1/supplier_status_links":
      return { body: [SUPPLIER_LINK] };
    case "/rest/v1/rpc/org_members":
      return { body: [{ user_id: USER, email: "owner@harbor.example", role: "owner", joined_at: "2026-09-01T00:00:00Z" }] };
    case "/rest/v1/rpc/early_payment_offers_ready":
      return { body: true };
    default:
      return { body: [] };
  }
}

/** What a request asked for, in a word: its path, and the provider for a connection. */
function label(request: RecordedRequest): string {
  const path = request.path.replace("/rest/v1/", "");
  const provider = request.params.get("provider");
  return provider ? `${path}?provider=${provider.replace("eq.", "")}` : path;
}

/** A fake whose answers come in waves: every request held until none has arrived for `QUIET_MS`, then all answered. */
const QUIET_MS = 25;
function inWaves() {
  const waves: string[][] = [];
  let held: Array<() => void> = [];
  let batch: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = () => {
    waves.push(batch);
    const release = held;
    held = [];
    batch = [];
    for (const go of release) go();
  };
  const fake = fakeSupabase(
    (request) =>
      new Promise<FakeReply>((resolve) => {
        batch.push(label(request));
        held.push(() => resolve(reply(request)));
        clearTimeout(timer);
        timer = setTimeout(answer, QUIET_MS);
      })
  );
  /** The wave a read was answered in, from 0; -1 when it was never made. */
  const waveOf = (name: string) => waves.findIndex((wave) => wave.includes(name));
  /** Every wave, one a line: what a failed expectation shows. */
  const dump = () => waves.map((wave, i) => `${i}: ${wave.join(", ")}`).join(" | ");
  return { fake, waves, waveOf, dump };
}

let fake: ReturnType<typeof inWaves>;

beforeEach(() => {
  // The payments switch is held for ten seconds once read: each test reads it, so each counts the same waves.
  forgetPaymentsSwitch();
  fake = inWaves();
  world.run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.fake.client, orgId: ORG, userId: USER }), fn);
  // Xero set up on the deployment: its bills brought in and its payments to book each need its connection.
  vi.stubEnv("XERO_CLIENT_ID", "A".repeat(32));
  vi.stubEnv("XERO_CLIENT_SECRET", "test-xero-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const open = (searchParams: Record<string, string> = {}) => InvoicesPage({ params: Promise.resolve({ slug: ACCESS.membership.slug }), searchParams: Promise.resolve(searchParams) });

describe("Bills & receivables' reads", () => {
  it("start together when they wait on nothing but the workspace and the address", async () => {
    await open({ filter: "all" });
    // The bills, the counterparties, what customers said, the drafts captured, the payments applied, the projects for
    // New ▾, the header's shadow mode and the Xero connection: all asked for before any answer came.
    for (const read of ["invoices", "counterparties", "customer_requests", "invoice_drafts", "receivable_allocations", "incoming_transfers", "projects", "shadow_modes", "accounting_connections?provider=xero"]) {
      expect({ read, wave: fake.waveOf(read) }, fake.dump()).toEqual({ read, wave: 0 });
    }
    // The entries about the bills start the moment the bills answer, not after every other first read.
    expect(fake.waveOf("rpc/ledger_entries_for_targets")).toBe(1);
  });

  it("read the tab shown beside the cards shown, so the whole page takes a handful of waves", async () => {
    await open({ filter: "all" });
    // The cards and the tab wait on the bills' decisions: the bills, then their entries, then shadow mode and the verdicts
    // given, then the capability those decide.
    const cards = fake.waveOf("payment_intents");
    expect(cards, fake.dump()).toBe(4);
    // The Bills tab's own reads, and the members, start with the cards' payments.
    for (const read of ["rpc/early_payment_offers_ready", "supplier_status_links", "rpc/org_members"]) {
      expect({ read, wave: fake.waveOf(read) }, fake.dump()).toEqual({ read, wave: cards });
    }
    // The receipts wait only on the payments; the offers' reads only on whether offers are set up, not on each other.
    for (const read of ["payment_receipts", "early_payment_offers", "accounts"]) {
      expect({ read, wave: fake.waveOf(read) }, fake.dump()).toEqual({ read, wave: cards + 1 });
    }
    // Before, each read waited for the one above it: eighteen waves here. Now six.
    expect(fake.waves.length, fake.dump()).toBe(cards + 2);
  });

  it("read the Receivables tab beside its cards too", async () => {
    await open({ tab: "receivables" });
    const cards = fake.waveOf("receivable_links");
    expect(cards).toBe(4);
    // The statement links, the customers' discounts and the collections' open tasks start with the cards' pay links: the
    // collections no longer wait for the members, which they need only to build.
    for (const read of ["customer_portal_links", "rpc/customer_discounts_ready", "collection_tasks", "rpc/org_members"]) {
      expect({ read, wave: fake.waveOf(read) }, fake.dump()).toEqual({ read, wave: cards });
    }
    expect(fake.waves.length).toBe(cards + 2);
  });

  it("read the Payment plan beside the cash priority order, not after it", async () => {
    await open({ tab: "plan" });
    // The plan reads the budgets; the order first asks whether shadow mode is on (it has no order then).
    const tab = fake.waveOf("agent_budgets");
    expect(tab).toBe(4);
    expect(fake.waves[tab]).toContain("shadow_modes");
  });

  it("make a read once that two parts need", async () => {
    await open({ filter: "all" });
    const made = (name: string) => fake.waves.flat().filter((read) => read === name).length;
    // The members name the waiting bill's owners and who made the supplier link.
    expect(made("rpc/org_members")).toBe(1);
    // Xero's connection serves its bills brought in and its payments to book.
    expect(made("accounting_connections?provider=xero")).toBe(1);
  });
});
