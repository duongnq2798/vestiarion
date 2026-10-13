import { describe, expect, it } from "vitest";
import type { Connection } from "@/lib/connectors/connections";
import type { CrmFieldRead, CrmReceiptWriter } from "@/lib/connectors/crm";
import { RECEIPT_FIELDS, type ReceiptFields } from "@/lib/connectors/crm-receipts";
import {
  conflictKey,
  queueReceipts,
  sendReceipts,
  writeGate,
  type LinkedDealFields,
  type ReceiptStore,
  type ReceiptWriteRow,
  type WritePatch,
  type WriteState,
} from "@/lib/connectors/crm-receipts-run";
import { ProviderError } from "@/lib/connectors/provider";
import type { LedgerEntryInput } from "@/lib/ledger";

/**
 * Receipts written back to the CRM, run by run (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3-R6), with a
 * fake CRM and a fake store: what is queued, the reality rule against the account as the CRM says it is, a conflict
 * never written over, the read-back that acknowledges a write, an outage that waits and retries, and nothing sent while
 * writing is off or not allowed.
 */

const NOW = Date.parse("2026-10-13T08:00:00.000Z");
const WRITE_SCOPES = ["crm.objects.deals.write", "crm.schemas.deals.write"];

const connection: Connection = {
  id: "conn-1",
  orgId: "org-1",
  provider: "hubspot",
  externalOrgId: "48291736",
  externalOrgName: "northstar.example",
  status: "connected",
  scopes: ["oauth", "crm.objects.deals.read", ...WRITE_SCOPES],
  connectedBy: "user-1",
  connectedAt: "2026-10-12T07:00:00.000Z",
  consentVersion: "hubspot-2026-10-13",
  consentedAt: "2026-10-12T07:00:00.000Z",
  revokedAt: null,
  windowFrom: "2026-07-14",
  lastSyncedAt: null,
  lastError: null,
  lastErrorAt: null,
  failures: 0,
  nextSyncAfter: null,
  syncLeaseUntil: null,
  paymentAccount: null,
  paymentAccountAt: null,
};

const fields = (collected: string, owed: string): ReceiptFields => ({
  vestiarion_collected: collected,
  vestiarion_still_owed: owed,
  vestiarion_currency: "USDC",
  vestiarion_collection_status: Number(owed) > 0 ? "partly_paid" : "paid_in_full",
  vestiarion_last_receipt_date: "2026-10-12",
  vestiarion_last_receipt_amount: collected,
  vestiarion_last_receipt_link: `https://explorer.testnet.arc.io/tx/0x${"ab".repeat(32)}`,
  vestiarion_reconciliation: "reconciled",
  vestiarion_evidence_link: "https://www.vestiarion.xyz/o/northstar/invoices/deals/deal-1",
});

const linked = (f: ReceiptFields, extra: Partial<LinkedDealFields> = {}): LinkedDealFields => ({
  crmDealId: "crm-1",
  dealId: "deal-1",
  externalDealId: "9001",
  title: "Website rebuild",
  fields: f,
  network: "arc-testnet",
  shadow: false,
  ...extra,
});

const MOVES: Record<WriteState, WriteState[]> = {
  queued: ["sending", "superseded", "refused"],
  failed: ["sending", "superseded", "refused"],
  conflict: ["queued", "superseded"],
  sending: ["queued", "sent", "written", "failed", "conflict", "refused"],
  sent: ["written", "failed", "conflict"],
  written: [],
  refused: [],
  superseded: [],
};

/** A store in memory that holds the database's rules: one write in hand per deal, the transitions, and the reality check. */
function memoryStore(deals: LinkedDealFields[], rows: ReceiptWriteRow[] = []) {
  const entries: LedgerEntryInput[] = [];
  let next = rows.length + 1;
  const store: ReceiptStore = {
    async linkedDeals() {
      return deals;
    },
    async latest(_connectionId, ids) {
      const latest = new Map<string, ReceiptWriteRow>();
      for (const row of [...rows].reverse()) if (ids.includes(row.crmDealId) && row.state !== "superseded" && !latest.has(row.crmDealId)) latest.set(row.crmDealId, row);
      return latest;
    },
    async owned(crmDealId) {
      const last = [...rows].reverse().find((row) => row.crmDealId === crmDealId && row.state === "written");
      return last?.readBack ?? null;
    },
    async unacknowledged(crmDealId, exceptId) {
      const own = rows.filter((row) => row.crmDealId === crmDealId);
      const lastWritten = own.map((row) => row.state).lastIndexOf("written");
      return own
        .slice(lastWritten + 1)
        .filter((row) => row.id !== exceptId && row.attempts > 0 && ["failed", "superseded", "conflict"].includes(row.state))
        .reverse()
        .map((row) => row.fields);
    },
    async insert(_connection, deal, chosen) {
      if (rows.some((row) => row.crmDealId === deal.crmDealId && ["queued", "sending", "sent", "failed", "conflict"].includes(row.state))) return null;
      const row: ReceiptWriteRow = {
        id: `write-${next++}`,
        connectionId: connection.id,
        crmDealId: deal.crmDealId,
        dealId: deal.dealId,
        externalDealId: deal.externalDealId,
        fields: deal.fields,
        network: deal.network,
        shadow: deal.shadow,
        accountType: null,
        accountTest: null,
        state: "queued",
        reason: null,
        message: null,
        attempts: 0,
        nextAttemptAt: null,
        sendingUntil: null,
        conflicts: [],
        overwrite: chosen?.overwrite ?? null,
        overwriteBy: chosen?.overwriteBy ?? null,
        overwriteAt: chosen?.overwriteAt ?? null,
        readBack: null,
        sentAt: null,
        writtenAt: null,
        createdAt: new Date(NOW).toISOString(),
      };
      rows.push(row);
      return row;
    },
    async move(row, from, to, patch: Partial<WritePatch>, options) {
      const current = rows.find((candidate) => candidate.id === row.id);
      if (!current) return null;
      // A claim (with `leaseOverAt`) takes a write being sent only once its lease ran out; a send moves its own claim on.
      const fromOk = from.includes(current.state) && (current.state !== "sending" || options?.leaseOverAt === undefined || (current.sendingUntil ?? "") <= options.leaseOverAt);
      // Only the write as the caller read it: another run's claim since counted an attempt.
      if (!fromOk || current.attempts !== row.attempts) return null;
      if (!MOVES[current.state].includes(to)) throw new Error(`crm_receipt_write_transition: ${current.state} to ${to}`);
      const after: ReceiptWriteRow = { ...current, ...(Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<ReceiptWriteRow>), state: to };
      if (["sending", "sent", "written"].includes(to) && !(after.network === "arc-mainnet" && !after.shadow) && after.accountTest !== true) {
        throw new Error("crm_receipt_writes_reality_check");
      }
      rows[rows.indexOf(current)] = after;
      return after;
    },
    async due(_connectionId, nowIso) {
      return rows.filter(
        (row) =>
          row.state === "queued" ||
          row.state === "sent" ||
          (row.state === "failed" && (row.nextAttemptAt ?? "") <= nowIso) ||
          (row.state === "sending" && (row.sendingUntil ?? "") <= nowIso)
      );
    },
    async record(entry) {
      entries.push(entry);
    },
  };
  return { store, rows, entries };
}

/** A CRM in memory: one deal's fields, the account's type, and what each call does. */
function fakeCrm(options: {
  test?: boolean;
  held?: Record<string, string | null>;
  found?: boolean;
  account?: () => never;
  write?: (values: Readonly<Record<string, string>>) => { ok: true } | { ok: false; message: string } | "throw-unavailable" | "throw-rate-limited" | "throw-forbidden" | "lost";
  afterWrite?: (values: Readonly<Record<string, string>>) => Record<string, string | null>;
}) {
  const calls: string[] = [];
  let held: Record<string, string | null> = options.held ?? Object.fromEntries(RECEIPT_FIELDS.map((name) => [name, null]));
  const writer: CrmReceiptWriter = {
    writeScopes: WRITE_SCOPES,
    async account() {
      calls.push("account");
      if (options.account) options.account();
      return { accountType: options.test === false ? "STANDARD" : "DEVELOPER_TEST", test: options.test !== false };
    },
    async ensureFields() {
      calls.push("ensure");
      return { ok: true };
    },
    async readFields(): Promise<CrmFieldRead> {
      calls.push("read");
      return options.found === false ? { found: false } : { found: true, values: { ...held } };
    },
    async writeFields({ values }) {
      calls.push("write");
      const outcome = options.write?.(values) ?? { ok: true };
      if (outcome === "throw-unavailable") throw new ProviderError("unavailable", "HubSpot deal update: no answer");
      if (outcome === "throw-rate-limited") throw new ProviderError("rate_limited", "HubSpot deal update: 429", 10_000);
      if (outcome === "throw-forbidden") throw new ProviderError("forbidden", "HubSpot deal update: 403");
      if (outcome === "lost") {
        held = { ...held, ...values };
        throw new ProviderError("unavailable", "HubSpot deal update: 502");
      }
      if (outcome.ok) held = options.afterWrite ? options.afterWrite(values) : { ...held, ...values };
      return outcome;
    },
  };
  return { writer, calls, held: () => held };
}

const run = (store: ReceiptStore, writer: CrmReceiptWriter, extra: { writesOn?: boolean; connection?: Connection; now?: number } = {}) =>
  sendReceipts({ connection: extra.connection ?? connection, writer, label: "HubSpot", store, accessToken: async () => "access-1", now: () => extra.now ?? NOW, writesOn: extra.writesOn ?? true });

describe("writeGate", () => {
  it("writes only for a connected connection, with writing on and every write scope granted", () => {
    expect(writeGate({ ...connection, writesOn: true }, WRITE_SCOPES)).toEqual({ ok: true });
    expect(writeGate({ ...connection, writesOn: false }, WRITE_SCOPES)).toEqual({ ok: false, reason: "off" });
    expect(writeGate({ ...connection, scopes: ["oauth", "crm.objects.deals.write"], writesOn: true }, WRITE_SCOPES)).toEqual({ ok: false, reason: "scope" });
    expect(writeGate({ ...connection, status: "needs_reconnect", writesOn: true }, WRITE_SCOPES)).toEqual({ ok: false, reason: "reconnect" });
    expect(writeGate({ ...connection, status: "revoked", writesOn: true }, WRITE_SCOPES)).toEqual({ ok: false, reason: "disconnected" });
  });
});

describe("queueReceipts", () => {
  it("queues each deal once, and the same figures never twice, whatever became of the last write", async () => {
    const { store, rows } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    expect(await queueReceipts({ connection, store })).toEqual({ queued: 1 });
    expect(await queueReceipts({ connection, store })).toEqual({ queued: 0 });
    rows[0] = { ...rows[0], state: "refused" };
    expect(await queueReceipts({ connection, store })).toEqual({ queued: 0 });
  });

  it("supersedes a write still queued, failed or in conflict with newer figures, and leaves one in flight to finish", async () => {
    const deals = [linked(fields("2000.00", "3000.00"))];
    const { store, rows } = memoryStore(deals);
    await queueReceipts({ connection, store });
    deals[0] = linked(fields("5000.00", "0.00"));
    expect(await queueReceipts({ connection, store })).toEqual({ queued: 1 });
    expect(rows.map((row) => row.state)).toEqual(["superseded", "queued"]);
    rows[1] = { ...rows[1], state: "sent" };
    deals[0] = linked(fields("5000.00", "100.00"));
    expect(await queueReceipts({ connection, store })).toEqual({ queued: 0 });
  });
});

describe("sendReceipts", () => {
  it("writes, reads back, and records it written only once the CRM read it back the same", async () => {
    const { store, rows, entries } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({});
    expect(await run(store, crm.writer)).toMatchObject({ written: 1, failed: 0, conflicts: 0 });
    expect(crm.calls).toEqual(["account", "ensure", "read", "write", "read"]);
    expect(rows[0]).toMatchObject({ state: "written", accountType: "DEVELOPER_TEST", accountTest: true, writtenAt: new Date(NOW).toISOString() });
    expect(rows[0].readBack?.vestiarion_collected).toBe("2000.00");
    expect(entries.map((entry) => entry.action)).toEqual(["crm_receipt_written"]);
    expect(entries[0].summary).toMatch(/collected 2,000\.00 USDC, still owed 3,000\.00 USDC/);
  });

  it("sends nothing while writing is off, or HubSpot has not granted every write scope", async () => {
    const { store, rows } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({});
    expect(await run(store, crm.writer, { writesOn: false })).toMatchObject({ written: 0 });
    expect(await run(store, crm.writer, { connection: { ...connection, scopes: ["oauth", "crm.objects.deals.read"] } })).toMatchObject({ written: 0 });
    expect(crm.calls).toEqual([]);
    expect(rows[0].state).toBe("queued");
  });

  it("refuses payments on Arc testnet into a real HubSpot account, and says so once", async () => {
    const { store, rows, entries } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({ test: false });
    expect(await run(store, crm.writer)).toMatchObject({ refused: 1, written: 0 });
    expect(crm.calls).toEqual(["account"]);
    expect(rows[0]).toMatchObject({ state: "refused", reason: "reality", accountType: "STANDARD", accountTest: false });
    expect(rows[0].message).toMatch(/only to a HubSpot developer test account or sandbox, never to a real HubSpot account/);
    expect(entries.map((entry) => entry.action)).toEqual(["crm_receipt_refused"]);
  });

  it("refuses shadow mode's on Arc mainnet too, and writes Arc mainnet's own to a real account", async () => {
    const shadow = memoryStore([linked(fields("2000.00", "3000.00"), { network: "arc-mainnet", shadow: true })]);
    await queueReceipts({ connection, store: shadow.store });
    expect(await run(shadow.store, fakeCrm({ test: false }).writer)).toMatchObject({ refused: 1 });
    const mainnet = memoryStore([linked(fields("2000.00", "3000.00"), { network: "arc-mainnet" })]);
    await queueReceipts({ connection, store: mainnet.store });
    expect(await run(mainnet.store, fakeCrm({ test: false }).writer)).toMatchObject({ written: 1 });
  });

  it("neither writes nor refuses when the account could not be read: the next run reads it again", async () => {
    const { store, rows } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({
      account: () => {
        throw new ProviderError("unavailable", "HubSpot account details: 503");
      },
    });
    expect(await run(store, crm.writer)).toMatchObject({ waiting: 1, written: 0, refused: 0 });
    expect(rows[0].state).toBe("queued");
  });

  it("leaves a later run's claim alone when its own lease ran out mid-send", async () => {
    const { store, rows, entries } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({});
    const slow: CrmReceiptWriter = {
      ...crm.writer,
      async ensureFields() {
        // HubSpot is slow: the lease runs out, and another run (Sync now) claims the same write.
        rows[0] = { ...rows[0], attempts: rows[0].attempts + 1, sendingUntil: new Date(NOW + 5 * 60_000).toISOString() };
        return { ok: false, message: "HubSpot said: try again" };
      },
    };
    expect(await run(store, slow)).toMatchObject({ failed: 0, waiting: 1 });
    // The later run's claim stands: still being sent, by it, with no failure recorded for it.
    expect(rows[0]).toMatchObject({ state: "sending", attempts: 2 });
    expect(entries).toEqual([]);
  });

  it("neither writes nor refuses for good when HubSpot names no type for the account", async () => {
    const { store, rows, entries } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({});
    const unnamed: CrmReceiptWriter = { ...crm.writer, account: async () => ({ accountType: null, test: null }) };
    expect(await run(store, unnamed)).toMatchObject({ waiting: 1, written: 0, refused: 0 });
    expect(rows[0].state).toBe("queued");
    expect(entries).toEqual([]);
    // Read again at the next run: a developer test account, so written.
    expect(await run(store, crm.writer)).toMatchObject({ written: 1 });
  });

  it("reports a field someone changed in HubSpot since the last write, and writes nothing over it", async () => {
    const first = fields("2000.00", "3000.00");
    const written: ReceiptWriteRow = {
      ...(await (async () => {
        const { store, rows } = memoryStore([linked(first)]);
        await queueReceipts({ connection, store });
        return rows[0];
      })()),
      state: "written",
      readBack: first,
      writtenAt: "2026-10-12T10:00:00.000Z",
      id: "write-0",
    };
    const { store, rows, entries } = memoryStore([linked(fields("5000.00", "0.00"))], [written]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({ held: { ...first, vestiarion_still_owed: "0" } });
    expect(await run(store, crm.writer)).toMatchObject({ conflicts: 1, written: 0 });
    expect(crm.calls).not.toContain("write");
    expect(rows[1]).toMatchObject({ state: "conflict", reason: "changed_in_crm" });
    expect(rows[1].conflicts).toEqual([{ field: "vestiarion_still_owed", ours: "3000", theirs: "0", next: "0" }]);
    expect(entries.map((entry) => entry.action)).toEqual(["crm_receipt_conflict"]);
    expect(conflictKey(rows[1].conflicts)).toMatch(/^[0-9a-f]{64}$/);

    // A person chose to write Vestiarion's figures over exactly what they saw: queued again, and written.
    const chosen = await store.move(rows[1], ["conflict"], "queued", { overwrite: { vestiarion_still_owed: "0" }, overwriteBy: "user-1", overwriteAt: "2026-10-13T08:00:00.000Z" });
    expect(chosen?.state).toBe("queued");
    expect(await run(store, crm.writer)).toMatchObject({ written: 1 });
    expect(crm.held().vestiarion_collected).toBe("5000.00");
  });

  it("keeps a person's choice to write over a change when newer figures supersede the write before it is sent", async () => {
    const first = fields("2000.00", "3000.00");
    const written: ReceiptWriteRow = {
      ...(await (async () => {
        const { store, rows } = memoryStore([linked(first)]);
        await queueReceipts({ connection, store });
        return rows[0];
      })()),
      state: "written",
      readBack: first,
      writtenAt: "2026-10-12T10:00:00.000Z",
      id: "write-0",
    };
    const deals = [linked(fields("5000.00", "0.00"))];
    const { store, rows, entries } = memoryStore(deals, [written]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({ held: { ...first, vestiarion_still_owed: "0" } });
    expect(await run(store, crm.writer)).toMatchObject({ conflicts: 1 });
    // A person chooses to write Vestiarion's figures over exactly what they saw.
    await store.move(rows[1], ["conflict"], "queued", { overwrite: { vestiarion_still_owed: "0" }, overwriteBy: "user-1", overwriteAt: "2026-10-13T08:00:00.000Z" });
    // Before the next send, another receipt arrives: newer figures supersede the write the person chose.
    deals[0] = linked(fields("5500.00", "0.00"));
    expect(await queueReceipts({ connection, store })).toEqual({ queued: 1 });
    expect(rows.map((row) => row.state)).toEqual(["written", "superseded", "queued"]);
    expect(rows[2]).toMatchObject({ overwrite: { vestiarion_still_owed: "0" }, overwriteBy: "user-1", overwriteAt: "2026-10-13T08:00:00.000Z" });
    // Written while HubSpot still holds what the person saw, with no second conflict to choose on again.
    expect(await run(store, crm.writer)).toMatchObject({ written: 1, conflicts: 0 });
    expect(crm.held().vestiarion_collected).toBe("5500.00");
    expect(entries.map((entry) => entry.action)).toEqual(["crm_receipt_conflict", "crm_receipt_written"]);
  });

  it("acknowledges a write that landed while its answer was lost, by reading back before anything else", async () => {
    const { store, rows } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({ write: () => "lost" });
    expect(await run(store, crm.writer)).toMatchObject({ written: 1 });
    expect(rows[0].state).toBe("written");
  });

  it("never takes its own write that landed unanswered for someone's change, once newer figures superseded it", async () => {
    const deals = [linked(fields("2000.00", "3000.00"))];
    const { store, rows, entries } = memoryStore(deals);
    await queueReceipts({ connection, store });
    // HubSpot takes the write but its answer is lost, and the read-back right after finds no answer either.
    let held: Record<string, string | null> = Object.fromEntries(RECEIPT_FIELDS.map((name) => [name, null]));
    let down = false;
    const flaky: CrmReceiptWriter = {
      ...fakeCrm({}).writer,
      async readFields() {
        if (down) throw new ProviderError("unavailable", "HubSpot deal: no answer");
        return { found: true, values: { ...held } };
      },
      async writeFields({ values }) {
        held = { ...held, ...values };
        down = true;
        throw new ProviderError("unavailable", "HubSpot deal update: no answer");
      },
    };
    expect(await run(store, flaky)).toMatchObject({ failed: 1, written: 0 });
    expect(rows[0]).toMatchObject({ state: "failed", reason: "no_answer" });
    // A payment arrives before the retry: newer figures supersede the write HubSpot in fact took.
    deals[0] = linked(fields("5000.00", "0.00"));
    expect(await queueReceipts({ connection, store })).toEqual({ queued: 1 });
    expect(rows.map((row) => row.state)).toEqual(["superseded", "queued"]);
    // HubSpot is back, holding Vestiarion's own first figures: no one changed them, so the newer ones are written.
    const back = fakeCrm({ held });
    expect(await run(store, back.writer, { now: NOW + 120_000 })).toMatchObject({ written: 1, conflicts: 0 });
    expect(back.held().vestiarion_collected).toBe("5000.00");
    expect(entries.map((entry) => entry.action)).toEqual(["crm_receipt_failed", "crm_receipt_written"]);
  });

  it("still reports a field someone changed over a write of Vestiarion's that landed unanswered, and only that field", async () => {
    const deals = [linked(fields("2000.00", "3000.00"))];
    const { store, rows } = memoryStore(deals);
    await queueReceipts({ connection, store });
    expect(await run(store, fakeCrm({ write: () => "throw-unavailable" }).writer)).toMatchObject({ failed: 1 });
    deals[0] = linked(fields("5000.00", "0.00"));
    await queueReceipts({ connection, store });
    // HubSpot holds the first write's figures, one of them changed by a person since.
    const back = fakeCrm({ held: { ...fields("2000.00", "3000.00"), vestiarion_still_owed: "1" } });
    expect(await run(store, back.writer, { now: NOW + 120_000 })).toMatchObject({ conflicts: 1, written: 0 });
    expect(rows[1].conflicts).toEqual([{ field: "vestiarion_still_owed", ours: "", theirs: "1", next: "0" }]);
    expect(back.calls).not.toContain("write");
  });

  it("fails an unanswered write, retries it later on its own with a backoff, and records the failure once", async () => {
    const { store, rows, entries } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({ write: () => "throw-unavailable" });
    expect(await run(store, crm.writer)).toMatchObject({ failed: 1 });
    expect(rows[0]).toMatchObject({ state: "failed", reason: "no_answer", attempts: 1, nextAttemptAt: new Date(NOW + 60_000).toISOString() });
    // Not due before its time.
    expect(await run(store, crm.writer, { now: NOW + 30_000 })).toMatchObject({ failed: 0, written: 0 });
    expect(await run(store, crm.writer, { now: NOW + 61_000 })).toMatchObject({ failed: 1 });
    expect(rows[0]).toMatchObject({ attempts: 2, nextAttemptAt: new Date(NOW + 61_000 + 120_000).toISOString() });
    expect(entries.map((entry) => entry.action)).toEqual(["crm_receipt_failed"]);
    // HubSpot is back: written.
    const back = fakeCrm({});
    expect(await run(store, back.writer, { now: NOW + 200_000 })).toMatchObject({ written: 1 });
  });

  it("stops the run at a rate limit, and asks to allow writing again on a refused token", async () => {
    const { store, rows } = memoryStore([linked(fields("2000.00", "3000.00")), linked(fields("10.00", "0.00"), { crmDealId: "crm-2", dealId: "deal-2", externalDealId: "9002" })]);
    await queueReceipts({ connection, store });
    expect(await run(store, fakeCrm({ write: () => "throw-rate-limited" }).writer)).toMatchObject({ failed: 1, waiting: 1 });
    expect(rows.map((row) => row.state)).toEqual(["failed", "queued"]);
    expect(rows[0]).toMatchObject({ reason: "rate_limited", nextAttemptAt: new Date(NOW + 10_000).toISOString() });
    await run(store, fakeCrm({ write: () => "throw-forbidden" }).writer);
    expect(rows[1]).toMatchObject({ state: "failed", reason: "reconnect" });
    expect(rows[1].message).toMatch(/allow writing to HubSpot again/);
  });

  it("refuses a deal HubSpot no longer has", async () => {
    const { store, rows, entries } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    expect(await run(store, fakeCrm({ found: false }).writer)).toMatchObject({ refused: 1 });
    expect(rows[0]).toMatchObject({ state: "refused", reason: "deal_gone" });
    expect(entries.map((entry) => entry.action)).toEqual(["crm_receipt_refused"]);
  });

  it("fails a write HubSpot refused, in HubSpot's own words, and tries it again an hour later", async () => {
    const { store, rows } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    await run(store, fakeCrm({ write: () => ({ ok: false, message: "HubSpot said: Property values were not valid" }) }).writer);
    expect(rows[0]).toMatchObject({ state: "failed", reason: "refused_by_crm", message: "HubSpot said: Property values were not valid", nextAttemptAt: new Date(NOW + 3_600_000).toISOString() });
  });

  it("treats a read-back that differs right after the write as someone's change, never as written", async () => {
    const { store, rows } = memoryStore([linked(fields("2000.00", "3000.00"))]);
    await queueReceipts({ connection, store });
    const crm = fakeCrm({ afterWrite: (values) => ({ ...values, vestiarion_still_owed: "1" }) });
    expect(await run(store, crm.writer)).toMatchObject({ conflicts: 1, written: 0 });
    expect(rows[0].state).toBe("conflict");
  });
});
