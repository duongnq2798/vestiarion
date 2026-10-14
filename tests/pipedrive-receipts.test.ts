import { describe, expect, it } from "vitest";
import type { Connection } from "@/lib/connectors/connections";
import { RECEIPT_GROUP, RECEIPT_PROPERTIES, type ReceiptFields } from "@/lib/connectors/crm-receipts";
import { queueReceipts, sendReceipts, type LinkedDealFields, type ReceiptStore, type ReceiptWriteRow, type WritePatch } from "@/lib/connectors/crm-receipts-run";
import { ProviderError } from "@/lib/connectors/provider";
import type { LedgerEntryInput } from "@/lib/ledger";
import { pipedriveFieldName, pipedriveReceipts, PIPEDRIVE_REALITY_REFUSAL } from "@/lib/pipedrive/receipts";
import { API_DOMAIN, COMPANY_ID, fakePipedrive } from "./support/fake-pipedrive";

/**
 * Receipts written back to Pipedrive deals (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P11, P12),
 * through the core's outbox and an in-memory Pipedrive: the nine Vestiarion fields made once, of Vestiarion's own types,
 * a field of the same name and another type never touched; a write read back as Pipedrive's acknowledgement; a value
 * someone changed in Pipedrive never written over; and the reality rule: payments on Arc testnet or in shadow mode are
 * never written, since Pipedrive names no test company.
 */

const HOST = new URL(API_DOMAIN).host;
const CREDENTIAL = `pd1|${HOST}|v1u:access-a`;
const NOW = Date.parse("2026-10-14T09:00:00.000Z");
const account = { accessToken: CREDENTIAL, externalOrgId: String(COMPANY_ID) };

const connection: Connection = {
  id: "conn-pd", orgId: "org-1", provider: "pipedrive", externalOrgId: String(COMPANY_ID), externalOrgName: "Cedar & Co", status: "connected",
  scopes: ["base", "deals:full", "contacts:read", "deal-fields:full", "users:read", "recents:read", "webhooks:full"], connectedBy: "user-1",
  connectedAt: "2026-10-14T07:00:00.000Z", consentVersion: "pipedrive-2026-10-14", consentedAt: "2026-10-14T07:00:00.000Z", revokedAt: null, windowFrom: "2026-07-16",
  lastSyncedAt: null, lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null, syncLeaseUntil: null, paymentAccount: null, paymentAccountAt: null,
};

const fields = (collected: string, owed: string): ReceiptFields => ({
  vestiarion_collected: collected,
  vestiarion_still_owed: owed,
  vestiarion_currency: "USDC",
  vestiarion_collection_status: Number(owed) > 0 ? "partly_paid" : "paid_in_full",
  vestiarion_last_receipt_date: "2026-10-14",
  vestiarion_last_receipt_amount: collected,
  vestiarion_last_receipt_link: `https://arcscan.app/tx/0x${"ab".repeat(32)}`,
  vestiarion_reconciliation: "reconciled",
  vestiarion_evidence_link: "https://www.vestiarion.xyz/o/cedar/invoices/deals/deal-1",
});

/** The outbox in memory, holding the database's reality check (0107 and 0116): no Pipedrive write is ever a test account's. */
function memoryStore(deals: LinkedDealFields[]) {
  const rows: ReceiptWriteRow[] = [];
  const entries: LedgerEntryInput[] = [];
  const store: ReceiptStore = {
    linkedDeals: async () => deals,
    latest: async (_id, ids) => {
      const latest = new Map<string, ReceiptWriteRow>();
      for (const row of [...rows].reverse()) if (ids.includes(row.crmDealId) && row.state !== "superseded" && !latest.has(row.crmDealId)) latest.set(row.crmDealId, row);
      return latest;
    },
    owned: async (crmDealId) => [...rows].reverse().find((row) => row.crmDealId === crmDealId && row.state === "written")?.readBack ?? null,
    unacknowledged: async () => [],
    insert: async (_c, deal) => {
      if (rows.some((row) => row.crmDealId === deal.crmDealId && ["queued", "sending", "sent", "failed", "conflict"].includes(row.state))) return null;
      const row: ReceiptWriteRow = {
        id: `write-${rows.length + 1}`, connectionId: connection.id, crmDealId: deal.crmDealId, dealId: deal.dealId, externalDealId: deal.externalDealId, fields: deal.fields,
        network: deal.network, shadow: deal.shadow, accountType: null, accountTest: null, state: "queued", reason: null, message: null, attempts: 0, nextAttemptAt: null,
        sendingUntil: null, conflicts: [], overwrite: null, overwriteBy: null, overwriteAt: null, readBack: null, sentAt: null, writtenAt: null, createdAt: new Date(NOW).toISOString(),
      };
      rows.push(row);
      return row;
    },
    move: async (row, from, to, patch: Partial<WritePatch>) => {
      const current = rows.find((candidate) => candidate.id === row.id);
      if (!current || !from.includes(current.state) || current.attempts !== row.attempts) return null;
      const after = { ...current, ...(Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<ReceiptWriteRow>), state: to };
      // crm_receipt_writes_reality_check, with account_test never true for Pipedrive (crm_receipt_writes_account_test_check).
      if (after.accountTest === true) throw new Error("crm_receipt_writes_account_test_check");
      if (["sending", "sent", "written"].includes(to) && !(after.network === "arc-mainnet" && !after.shadow)) throw new Error("crm_receipt_writes_reality_check");
      rows[rows.indexOf(current)] = after;
      return after;
    },
    due: async (_id, nowIso) => rows.filter((row) => row.state === "queued" || row.state === "sent" || (row.state === "failed" && (row.nextAttemptAt ?? "") <= nowIso)),
    record: async (entry) => {
      entries.push(entry);
    },
  };
  return { store, rows, entries };
}

const deal = (f: ReceiptFields, extra: Partial<LinkedDealFields> = {}): LinkedDealFields => ({
  crmDealId: "crm-42", dealId: "deal-1", externalDealId: "42", title: "Spring campaign", fields: f, network: "arc-mainnet", shadow: false, ...extra,
});

async function runOnce(fake: ReturnType<typeof fakePipedrive>, memory: ReturnType<typeof memoryStore>, now = NOW) {
  const deps = { connection, writer: pipedriveReceipts({ fetchImpl: fake.fetchImpl, now: () => now }), label: "Pipedrive", store: memory.store, accessToken: async () => CREDENTIAL, now: () => now };
  const { queued } = await queueReceipts(deps);
  return { queued, ...(await sendReceipts({ ...deps, writesOn: true })) };
}

describe("Vestiarion's deal fields in Pipedrive", () => {
  it("makes the nine fields once, of Vestiarion's own types, and finds them the next run", async () => {
    const fake = fakePipedrive();
    expect(await pipedriveReceipts({ fetchImpl: fake.fetchImpl }).ensureFields({ ...account, group: RECEIPT_GROUP, properties: RECEIPT_PROPERTIES })).toEqual({ ok: true });
    const made = fake.requests.filter((sent) => sent.method === "POST" && sent.path === "/api/v2/dealFields").map((sent) => JSON.parse(sent.body) as { field_name: string; field_type: string });
    expect(made.map((field) => [field.field_name, field.field_type])).toEqual([
      ["Vestiarion: Collected", "double"],
      ["Vestiarion: Still owed", "double"],
      ["Vestiarion: Collection currency", "varchar"],
      ["Vestiarion: Collection status", "varchar"],
      ["Vestiarion: Last receipt date", "date"],
      ["Vestiarion: Last receipt amount", "double"],
      ["Vestiarion: Last receipt", "varchar"],
      ["Vestiarion: Reconciliation status", "varchar"],
      ["Vestiarion: Evidence", "varchar"],
    ]);
    const before = fake.requests.length;
    expect(await pipedriveReceipts({ fetchImpl: fake.fetchImpl }).ensureFields({ ...account, group: RECEIPT_GROUP, properties: RECEIPT_PROPERTIES })).toEqual({ ok: true });
    expect(fake.requests.slice(before).filter((sent) => sent.method === "POST")).toEqual([]);
  });

  it("never changes a field of the same name and another type, and writes nothing", async () => {
    const fake = fakePipedrive();
    fake.fields.push({ field_code: "f".repeat(40), field_name: pipedriveFieldName(RECEIPT_PROPERTIES[0]), field_type: "varchar", is_custom_field: true });
    const ready = await pipedriveReceipts({ fetchImpl: fake.fetchImpl }).ensureFields({ ...account, group: RECEIPT_GROUP, properties: RECEIPT_PROPERTIES });
    expect(ready).toEqual({ ok: false, message: expect.stringContaining('"Vestiarion: Collected" of another type') });
    expect(fake.requests.filter((sent) => sent.method !== "GET")).toEqual([]);
  });

  it("says in Pipedrive's words when its plan or the user's rights refuse the fields", async () => {
    const fake = fakePipedrive();
    fake.state.fieldsRefused = { status: 402, body: { success: false, error: "Custom fields limit reached for your plan" } };
    const ready = await pipedriveReceipts({ fetchImpl: fake.fetchImpl }).ensureFields({ ...account, group: RECEIPT_GROUP, properties: RECEIPT_PROPERTIES });
    expect(ready).toEqual({ ok: false, message: expect.stringContaining("Custom fields limit reached for your plan") });
    expect(ready.ok === false && ready.message).toMatch(/custom field limit may be reached, or the user who connected may not add fields/);
  });

  it("names a company, never a test one, and refuses a token of another company", async () => {
    const fake = fakePipedrive();
    expect(await pipedriveReceipts({ fetchImpl: fake.fetchImpl }).account(account)).toEqual({ accountType: "COMPANY", test: false });
    await expect(pipedriveReceipts({ fetchImpl: fake.fetchImpl }).account({ ...account, externalOrgId: "999" })).rejects.toEqual(expect.any(ProviderError));
  });
});

describe("receipts through the outbox", () => {
  it("writes a mainnet deal's figures, reads them back, and records the acknowledgement", async () => {
    const fake = fakePipedrive();
    fake.addDeal({ id: 42, title: "Spring campaign", status: "won" });
    const memory = memoryStore([deal(fields("20", "180"))]);
    const run = await runOnce(fake, memory);
    expect(run).toMatchObject({ queued: 1, written: 1, conflicts: 0, refused: 0 });
    expect(memory.rows[0]).toMatchObject({ state: "written", accountType: "COMPANY", accountTest: false });
    const byName = new Map(fake.fields.map((field) => [field.field_name, field.field_code]));
    const held = fake.deals.get(42)?.custom_fields ?? {};
    expect(held[byName.get("Vestiarion: Collected") as string]).toBe(20);
    expect(held[byName.get("Vestiarion: Collection status") as string]).toBe("Partly paid");
    expect(held[byName.get("Vestiarion: Last receipt date") as string]).toBe("2026-10-14");
    expect(memory.entries.map((entry) => entry.action)).toEqual(["crm_receipt_written"]);
    expect(memory.entries[0].detail).toMatchObject({ provider: "pipedrive", crmDealId: "42", accountType: "COMPANY" });
    // Pipedrive's own deal fields are never written: only Vestiarion's custom fields, by their keys.
    const patch = fake.requests.find((sent) => sent.method === "PATCH");
    expect(Object.keys(JSON.parse(patch?.body ?? "{}"))).toEqual(["custom_fields"]);
  });

  it("never writes over a value someone changed in Pipedrive: a conflict, for a person to choose", async () => {
    const fake = fakePipedrive();
    fake.addDeal({ id: 42, status: "won" });
    const first = memoryStore([deal(fields("20", "180"))]);
    await runOnce(fake, first);
    // Someone types over "Vestiarion: Collected" in Pipedrive; then the deal collects more in Vestiarion.
    const collected = fake.fields.find((field) => field.field_name === "Vestiarion: Collected")?.field_code as string;
    fake.deals.get(42)!.custom_fields![collected] = 50;
    const memory = { ...first, store: { ...first.store, linkedDeals: async () => [deal(fields("200", "0"))] } };
    const run = await runOnce(fake, memory, NOW + 60_000);
    expect(run).toMatchObject({ queued: 1, conflicts: 1, written: 0 });
    expect(fake.deals.get(42)!.custom_fields![collected]).toBe(50);
    expect(first.rows.at(-1)).toMatchObject({ state: "conflict", conflicts: [expect.objectContaining({ field: "vestiarion_collected", ours: "20", theirs: "50", next: "200" })] });
    expect(first.entries.map((entry) => entry.action)).toContain("crm_receipt_conflict");
  });

  it("never writes payments on Arc testnet, or in shadow mode, to Pipedrive: refused with the reason, nothing sent", async () => {
    for (const reality of [{ network: "arc-testnet" as const, shadow: false }, { network: "arc-mainnet" as const, shadow: true }]) {
      const fake = fakePipedrive();
      fake.addDeal({ id: 42, status: "won" });
      const memory = memoryStore([deal(fields("20", "180"), reality)]);
      const run = await runOnce(fake, memory);
      expect(run).toMatchObject({ refused: 1, written: 0 });
      expect(memory.rows[0]).toMatchObject({ state: "refused", reason: "reality", message: PIPEDRIVE_REALITY_REFUSAL });
      expect(fake.requests.filter((sent) => sent.method !== "GET")).toEqual([]);
      expect(memory.entries[0]).toMatchObject({ action: "crm_receipt_refused", detail: { reason: "reality", network: reality.network, shadow: reality.shadow, accountType: "COMPANY" } });
    }
  });

  it("refuses a write to a deal Pipedrive no longer has", async () => {
    const fake = fakePipedrive();
    const memory = memoryStore([deal(fields("20", "180"))]);
    const run = await runOnce(fake, memory);
    expect(run).toMatchObject({ refused: 1 });
    expect(memory.rows[0]).toMatchObject({ state: "refused", reason: "deal_gone" });
  });
});
