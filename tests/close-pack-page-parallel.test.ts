import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { LedgerEntryInput } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The monthly close pack's page reads at once (docs/superpowers/specs/2026-10-26-close-pack-page-speed-design.md CS2-CS4,
 * CS7): every read that waits on nothing but the workspace and the month starts together, the header's included; a
 * read that waits on another starts the moment that one answers; the screening is one read, beside the payees; and the
 * page and its read each log one timing line.
 *
 * The fake database answers in waves, as the Bills page's test does (tests/bills-page-parallel.test.ts): it holds every
 * request until none has arrived for a moment, then answers them all together, so a read's wave says what it waited for.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/googlesheets", () => ({ exportClosePackToSheetsAction: vi.fn(), disconnectGoogleSheetsAction: vi.fn() }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const ACCESS = {
  user: { id: USER, email: "owner@pinecrest.example" },
  membership: { orgId: ORG, slug: "pinecrest-studio", name: "Pinecrest Studio", mode: "live" as const, role: "owner" as const, network: "arc-testnet" as const },
};

const world = vi.hoisted(() => ({ run: null as null | (<T>(fn: () => Promise<T>) => Promise<T>) }));
const key = crypto.generateKeyPairSync("ed25519");

vi.mock("@/lib/auth/membership", () => ({ requireMembership: vi.fn(async () => ACCESS) }));
vi.mock("@/lib/dal/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal/scope")>()),
  inOrg: (_access: unknown, fn: () => Promise<unknown>) => (world.run as NonNullable<typeof world.run>)(fn),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: key.publicKey, retired: [] }),
}));

import ClosePackPage from "@/app/o/[slug]/evidence/close-pack/page";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const CP1 = "c0000000-0000-4000-8000-000000000001";
const CP2 = "c0000000-0000-4000-8000-000000000002";
const INV1 = "a0000000-0000-4000-8000-000000000101";
const INV2 = "a0000000-0000-4000-8000-000000000102";
const TX1 = `0x${"1".repeat(64)}`;
const TX2 = `0x${"2".repeat(64)}`;

// Two bills paid in September: one the agent decided, one a person approved; each payee given its address.
const ENTRIES: LedgerEntryInput[] = [
  { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Coastal Flour Mill", detail: { by: USER, counterpartyId: CP1, address: `0x${"a".repeat(40)}` } },
  { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Harbor Print", detail: { by: USER, counterpartyId: CP2, address: `0x${"b".repeat(40)}` } },
  { actor: "human", domain: "ap", action: "create_invoice", summary: "Added a bill", detail: { by: USER, invoiceId: INV1, counterpartyId: CP1, amount: 120, currency: "USDC" } },
  { actor: "human", domain: "ap", action: "create_invoice", summary: "Added a bill", detail: { by: USER, invoiceId: INV2, counterpartyId: CP2, amount: 80, currency: "USDC" } },
  {
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: "PAY",
    detail: { invoiceId: INV1, counterpartyId: CP1, decision: { action: "pay" }, decisionMode: "anthropic", guardrailBlocked: false, observed: { amount: 120, riskLevel: "clear" }, execution: { txRef: TX1, resultingStatus: "paid" } },
  },
  { actor: "human", domain: "ap", action: "approval_paid", summary: "Approved and paid", detail: { by: USER, invoiceId: INV2, counterpartyId: CP2, txRef: TX2, status: "paid" } },
];
const ROWS = buildChain(ENTRIES, key.privateKey, ledgerKeyId(key.publicKey)).map((row, index) => ({ ...row, ts: `2026-09-0${index + 1}T10:00:00+00:00`, org_id: ORG }));

const intent = (id: string, invoiceId: string, tx: string, day: string) => ({
  id,
  source_type: "invoice",
  source_id: invoiceId,
  status: "confirmed",
  provider: "circle",
  provider_mode: "live",
  provider_tx_id: `circle-${id}`,
  provider_state: "COMPLETE",
  amount: "120.000000",
  token: "USDC",
  destination: `0x${"a".repeat(40)}`,
  tx_hash: tx,
  chain: "ARC-TESTNET",
  network: "arc-testnet",
  transfer_attempt: 1,
  previous_attempts: [],
  created_at: `2026-09-${day}T10:00:00+00:00`,
  submitted_at: `2026-09-${day}T10:00:00+00:00`,
  confirmed_at: `2026-09-${day}T10:00:05+00:00`,
});
const INTENTS = [intent("pay-1", INV1, TX1, "05"), intent("pay-2", INV2, TX2, "06")];
const INVOICES = [
  { id: INV1, direction: "payable", counterparty_id: CP1, amount: "120.000000", currency: "USDC", paid_amount: null, memo: null, po_reference: null, due_date: "2026-09-10", status: "paid", tx_ref: TX1, settled_at: "2026-09-05T10:00:06+00:00" },
  { id: INV2, direction: "payable", counterparty_id: CP2, amount: "80.000000", currency: "USDC", paid_amount: null, memo: null, po_reference: null, due_date: "2026-09-12", status: "paid", tx_ref: TX2, settled_at: "2026-09-06T10:00:06+00:00" },
];
const COUNTERPARTIES = [
  { id: CP1, name: "Coastal Flour Mill", address: `0x${"a".repeat(40)}`, chain: "ARC-TESTNET", sample: false },
  { id: CP2, name: "Harbor Print", address: `0x${"b".repeat(40)}`, chain: "ARC-TESTNET", sample: false },
];

const inList = (value: string | null) => (value?.startsWith("in.(") ? value.slice(4, -1).split(",").map((one) => one.replace(/^"|"$/g, "")) : []);

function reply(request: RecordedRequest): FakeReply {
  const p = request.params;
  switch (request.path) {
    case "/rest/v1/payment_intents":
      return { body: INTENTS };
    case "/rest/v1/invoices":
      return { body: (p.get("select") ?? "").includes("document_pay_to") ? [] : INVOICES.filter((row) => inList(p.get("id")).includes(row.id)) };
    case "/rest/v1/counterparties":
      return { body: COUNTERPARTIES.filter((row) => inList(p.get("id")).includes(row.id)) };
    case "/rest/v1/compliance_checks":
      return { body: inList(p.get("counterparty_id")).map((id) => ({ counterparty_id: id, risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-08-01T00:00:00+00:00" })) };
    case "/rest/v1/ledger_entries": {
      const invoiceIds = inList(p.get("detail->>invoiceId"));
      if (invoiceIds.length > 0) return { body: ROWS.filter((row) => invoiceIds.includes(String(row.detail.invoiceId))) };
      const payees = inList(p.get("detail->>counterpartyId"));
      if (payees.length > 0) return { body: ROWS.filter((row) => row.action === "create_counterparty" && payees.includes(String(row.detail.counterpartyId))) };
      return { body: [] };
    }
    case "/rest/v1/rpc/org_members":
      return { body: [{ user_id: USER, email: "owner@pinecrest.example", role: "owner", joined_at: "2026-01-01T00:00:00Z" }] };
    default:
      return { body: [] };
  }
}

/** What a request asked for, in a word: its path, and for the ledger which entries. */
function label(request: RecordedRequest): string {
  const path = request.path.replace("/rest/v1/", "");
  if (path !== "ledger_entries") return path;
  const p = request.params;
  if (p.get("order") === "seq.desc" && p.get("select") === "seq,hash") return "ledger:head";
  for (const field of ["invoiceId", "milestoneId", "subjectId", "counterpartyId"]) if (p.has(`detail->>${field}`)) return `ledger:${field}`;
  return `ledger:${(p.get("action") ?? "").replace(/^eq\./, "").replace(/^in\.\((.*)\)$/, "$1")}`;
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
let info: MockInstance<typeof console.info>;

beforeEach(() => {
  fake = inWaves();
  world.run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.fake.client, orgId: ORG, userId: USER }), fn);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const open = () => ClosePackPage({ params: Promise.resolve({ slug: ACCESS.membership.slug }), searchParams: Promise.resolve({ month: "2026-09" }) });
const made = (name: string) => fake.waves.flat().filter((read) => read === name).length;

describe("the monthly close pack page's reads", () => {
  it("start together when they wait on nothing but the workspace and the month, the header's included", async () => {
    await open();
    // The payments, the escrow moves, the payee lock's changes, the first sweep, the head, the members, and the header's
    // clock, last cycle and shadow mode: all asked for before any answer came.
    for (const read of ["payment_intents", "ledger:escrow_funded,escrow_refunded", "ledger:payee_lock_changed", "ledger:compliance_sweep", "ledger:head", "rpc/org_members", "sim_clock", "ledger:cycle_complete", "shadow_modes"]) {
      expect({ read, wave: fake.waveOf(read) }, fake.dump()).toEqual({ read, wave: 0 });
    }
  });

  it("read the bills, their entries and their verdicts the moment the payments answer", async () => {
    await open();
    for (const read of ["invoices", "ledger:invoiceId", "ledger:subjectId"]) {
      expect({ read, wave: fake.waveOf(read) }, fake.dump()).toEqual({ read, wave: 1 });
    }
  });

  it("read the payees, their address entries and every payment's screening together, so the page takes three waves", async () => {
    await open();
    for (const read of ["counterparties", "ledger:counterpartyId", "compliance_checks"]) {
      expect({ read, wave: fake.waveOf(read) }, fake.dump()).toEqual({ read, wave: 2 });
    }
    // Before, the payees waited for the bills' reads, the screening for the payees, ten payments at a time, and the
    // header's shadow mode for all of it: five waves here, six with eleven to twenty payments. Now three.
    expect(fake.waves.length, fake.dump()).toBe(3);
    expect(made("compliance_checks")).toBe(1);
  });

  it("read the header's clock and last cycle, and nothing the header does not show", async () => {
    await open();
    expect(made("sim_clock")).toBe(1);
    expect(made("ledger:cycle_complete")).toBe(1);
    // stats() read the paid bills and milestones and counted every agent entry and every flagged bill.
    const counted = fake.fake.requests.filter((request) => request.method === "HEAD" || (request.headers.get("prefer") ?? "").includes("count="));
    expect(counted).toHaveLength(0);
    expect(fake.fake.requests.some((request) => request.path === "/rest/v1/milestones" || request.params.get("status") === "eq.paid" || request.params.get("actor") === "eq.agent")).toBe(false);
  });

  it("log one timing line for the page and one for its read, naming no workspace or person", async () => {
    await open();
    const lines = info.mock.calls.filter(([name]) => name === "close_pack_timing").map(([, line]) => String(line));
    expect(lines.map((line) => (JSON.parse(line) as { stage: string }).stage)).toEqual(["read", "page"]);
    const page = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(Object.keys(page)).toEqual(["stage", "auth", "scope", "reads", "total", "pack"]);
    expect(page.pack).toBe(true);
    for (const stage of ["auth", "scope", "reads", "total"]) expect(Number.isInteger(page[stage]) && (page[stage] as number) >= 0, stage).toBe(true);
    for (const line of lines) for (const named of [ORG, USER, ACCESS.membership.slug, ACCESS.membership.name, ACCESS.user.email]) expect(line).not.toContain(named);
  });
});
