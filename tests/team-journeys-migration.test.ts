import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, appendSignedForOrg, asRole, asServiceRole, asTenant, createDatabase, createUser } from "./support/pglite";

let db: PGlite;
let team: string;
let customer: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const burn = `0x${"ab".repeat(32)}`;
const mint = `0x${"cd".repeat(32)}`;
const read = async () => (await db.query<{ value: { direct: Record<string, unknown> | null; base: Record<string, unknown> | null } }>("select public.landing_team_journeys() as value")).rows[0].value;

async function payment(options: { tag: string; creator?: string | null; mode?: string; sample?: boolean; network?: string; destination?: string; mint?: string | null; status?: string; providerMode?: string; at?: string }) {
  const orgId = (await db.query<{ id: string }>("insert into orgs(slug,name,mode,created_by,network) values($1,'PRIVATE-WORKSPACE',$2,$3,$4) returning id",
    [options.tag, options.mode ?? "live", options.creator === undefined ? team : options.creator, options.network ?? "arc-mainnet"])).rows[0].id;
  const counterpartyId = (await db.query<{ id: string }>("insert into counterparties(org_id,name,role,sample) values($1,'PRIVATE-NAME','vendor',$2) returning id", [orgId, options.sample ?? false])).rows[0].id;
  const invoiceId = (await db.query<{ id: string }>("insert into invoices(org_id,direction,counterparty_id,amount,due_date,status) values($1,'payable',$2,999,current_date,'paid') returning id", [orgId, counterpartyId])).rows[0].id;
  await db.query(`insert into payment_intents(org_id,source_type,source_id,idempotency_key,provider,provider_mode,amount,token,destination,status,network,chain,destination_chain,tx_hash,mint_tx_hash,confirmed_at)
    values($1,'invoice',$2,$3,'circle',$4,0.1,'USDC',$5,$6,$7,'ARC',$8,$9,$10,$11)`,
    [orgId, invoiceId, crypto.randomUUID(), options.providerMode ?? "live", `0x${"12".repeat(20)}`, options.status ?? "confirmed", options.network ?? "arc-mainnet", options.destination ?? "ARC", burn, options.mint ?? null, options.at ?? "2026-10-07T09:43:13Z"]);
  return { orgId, invoiceId, counterpartyId };
}

async function entry(orgId: string, invoiceId: string, action: string, extra: Record<string, unknown> = {}) {
  return appendSignedForOrg(db, orgId, { actor: action.startsWith("ap_") ? "agent" : "human", domain: "ap", action, summary: "PRIVATE-SUMMARY", detail: { invoiceId, reasoning: "PRIVATE-REASON", ...extra } }, privateKey);
}

beforeAll(async () => { db = await createDatabase(); await applyMigrations(db); team = await createUser(db, "journey-team@test.invalid"); customer = await createUser(db, "journey-customer@test.invalid"); await db.query("select set_platform_team_member('journey-team@test.invalid',true)"); }, 60_000);
afterAll(async () => { await db.close(); });

describe("landing_team_journeys", () => {
  it("returns empty slots before eligible payments exist", async () => { expect(await read()).toEqual({ direct: null, base: null }); });

  it("projects one actual paid bill's signed events and safe observations without names/reasoning/source ids", async () => {
    const p = await payment({ tag: "journey-direct" });
    const received = await entry(p.orgId, p.invoiceId, "create_invoice");
    const check = await entry(p.orgId, p.invoiceId, "ap_pay", { guardrailBlocked: true, guardrailRule: "counterparty.new_payee", observed: { amount: 999, poReference: "PRIVATE-PO", goodsReceived: true, purchaseOrderRequired: true, riskLevel: "clear" } });
    const approval = await entry(p.orgId, p.invoiceId, "approval_paid", { txRef: burn });
    await entry(p.orgId, p.invoiceId, "ap_hold", { guardrailBlocked: true, guardrailRule: "PRIVATE-RULE", observed: { riskLevel: "high", goodsReceived: false } });
    const result = (await read()).direct!;
    expect(result).toMatchObject({ orgId: p.orgId, amount: 0.1, currency: "USDC", network: "arc-mainnet", status: "paid", received: { seq: Number(received.seq), action: "create_invoice" }, check: { seq: Number(check.seq) }, hold: { seq: Number(check.seq) }, rule: "counterparty.new_payee", observed: { hasPurchaseOrder: true, goodsReceived: true, purchaseOrderRequired: true, riskLevel: "clear" } });
    const text = JSON.stringify(result);
    for (const secret of ["PRIVATE-", p.invoiceId, p.counterpartyId, "invoiceId", "reasoning", "summary"]) expect(text).not.toContain(secret);
    expect(result).toHaveProperty("record.link.signature");
    expect(result).toHaveProperty("record.seq", Number(approval.seq));
  });

  it("never widens proof to customers, sandboxes, samples, deleted creators, simulation or other networks", async () => {
    const before = (await read()).direct;
    for (const options of [{ creator: customer }, { mode: "sandbox" }, { sample: true }, { creator: null }, { providerMode: "simulate" }, { network: "arc-testnet" }, { status: "pending" }]) {
      await payment({ tag: `excluded-${crypto.randomUUID().slice(0, 12)}`, at: "2026-10-19T12:00:00Z", ...options });
    }
    expect((await read()).direct).toEqual(before);
  });

  it("requires the Base mint and selects newest confirmed eligible payment with missing events left unknown", async () => {
    await payment({ tag: "base-no-mint", destination: "BASE" });
    expect((await read()).base).toBeNull();
    await payment({ tag: "base-confirmed", destination: "BASE", mint, at: "2026-10-19T12:00:00Z" });
    const base = (await read()).base!;
    expect(base).toMatchObject({ amount: 0.1, received: null, check: null, hold: null, approval: null, record: null, payment: { route: "cctp", txHash: burn, mintTxHash: mint, destinationChain: "BASE", confirmationRecordedAt: "2026-10-19T12:00:00+00:00" } });
  });

  it("chooses the newest confirmation, keeps a nullable direct destination in the same slot, and never mixes another bill's events", async () => {
    const newest = await payment({ tag: "newest-direct", at: "2026-10-20T00:00:00Z" });
    await db.query("update payment_intents set destination_chain = null where org_id = $1", [newest.orgId]);
    await entry(newest.orgId, crypto.randomUUID(), "create_invoice");
    const result = (await read()).direct!;
    expect(result).toMatchObject({ orgId: newest.orgId, received: null, check: null, hold: null, approval: null, record: null });
    expect((await read()).direct).toEqual(result);
  });

  it("does not mistake a hash quoted in reasoning for a transaction recording", async () => {
    const p = await payment({ tag: "reasoning-not-record", at: "2026-10-21T00:00:00Z" });
    await entry(p.orgId, p.invoiceId, "approval_paid", { reasoning: `A private note mentions ${burn}` });
    expect((await read()).direct?.record).toBeNull();
  });

  it("is service-role-only, including denial to the tenant role", async () => {
    for (const role of ["anon", "authenticated"] as const) await expect(asRole(db, role, (tx) => tx.query("select landing_team_journeys()"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, null, tx => tx.query("select landing_team_journeys()"))).rejects.toThrow(/permission denied/);
    await expect(asServiceRole(db, (tx) => tx.query("select landing_team_journeys()"))).resolves.toBeDefined();
  });
});
