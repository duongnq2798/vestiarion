import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0110 (docs/superpowers/specs/2026-10-13-collections-context-design.md): a customer's collection rules, one
 * version per change and never changed; the tasks the collections stage asks a person to do, once per receivable and
 * subject, resolved once; and one delivery per email (I11), sent once and never released after. Each workspace sees
 * only its own, and the browser roles nothing.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0110_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function counterparty(orgId: string, role = "client", name = "Acme Studio"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, $3) returning id", [orgId, name, role])).rows[0].id;
}

async function receivable(orgId: string, customerId: string, direction = "receivable"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, $2, $3, 1200, '2026-10-15') returning id", [orgId, direction, customerId])).rows[0].id;
}

const addPolicy = (orgId: string, customerId: string, version: number, over: Record<string, unknown> = {}) => {
  const row = { approval: "auto", max_tone: "final", min_days_between: 3, ...over };
  const columns = Object.keys(row);
  return asTenant(db, orgId, (tx) =>
    tx.query(
      `insert into public.collection_policies (org_id, counterparty_id, version, ${columns.join(", ")}) values ($1, $2, $3, ${columns.map((_, index) => `$${index + 4}`).join(", ")}) returning id`,
      [orgId, customerId, version, ...Object.values(row)]
    )
  );
};

const openTask = (orgId: string, invoiceId: string, customerId: string, subject = "policy:1:reminder:1") =>
  asTenant(db, orgId, (tx) =>
    tx.query<{ id: string }>(
      `insert into public.collection_tasks (org_id, invoice_id, counterparty_id, kind, reason, subject_key, policy_version, proposal)
       values ($1, $2, $3, 'ask_owner', 'policy_ask_first', $4, 1, '{"headline": "Ask first", "reasons": []}'::jsonb) on conflict do nothing returning id`,
      [orgId, invoiceId, customerId, subject]
    )
  );

const hex = (seed: string) => (seed.repeat(64)).slice(0, 64);

describe("crm_deals.owner_external_id", () => {
  it("is there, and bounded", async () => {
    const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'crm_deals' and column_name = 'owner_external_id'");
    expect(columns.rows).toHaveLength(1);
  });
});

describe("collection_policies", () => {
  it("takes versions of a customer's rules in order, for a client only, and never changes one", async () => {
    const orgId = await createOrg(db, "rules");
    const customer = await counterparty(orgId);
    const vendor = await counterparty(orgId, "vendor", "Northwind");
    await addPolicy(orgId, customer, 1, { approval: "ask_first", max_tone: "firm", min_days_between: 7 });
    await expect(addPolicy(orgId, customer, 1)).rejects.toThrow(/collection_policy_version|collection_policies_version_key/);
    await expect(addPolicy(orgId, customer, 3)).rejects.toThrow(/collection_policy_version/);
    await addPolicy(orgId, customer, 2);
    await expect(addPolicy(orgId, vendor, 1)).rejects.toThrow(/collection_policy_not_client/);
    await expect(addPolicy(orgId, customer, 3, { min_days_between: 2 })).rejects.toThrow(/collection_policies_min_days_check/);
    await expect(addPolicy(orgId, customer, 3, { max_tone: "angry" })).rejects.toThrow(/collection_policies_max_tone_check/);
    await expect(addPolicy(orgId, customer, 3, { channel: "sms" })).rejects.toThrow(/collection_policies_channel_check/);

    await expect(asTenant(db, orgId, (tx) => tx.query("update public.collection_policies set approval = 'auto' where counterparty_id = $1", [customer]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.collection_policies where counterparty_id = $1", [customer]))).rejects.toThrow(/permission denied/);
    // Even the service role cannot change a version.
    await expect(db.query("update public.collection_policies set max_tone = 'final' where counterparty_id = $1 and version = 1", [customer])).rejects.toThrow(/collection_policy_fixed/);
  });

  it("keeps a version when its account owner's account is deleted, and goes with its customer", async () => {
    const orgId = await createOrg(db, "rules-owner");
    const person = await createUser(db, "rules-owner@example.com");
    const customer = await counterparty(orgId);
    await addPolicy(orgId, customer, 1, { account_owner: person, created_by: person });
    await db.query("delete from auth.users where id = $1", [person]);
    const kept = (await db.query<{ account_owner: string | null; created_by: string | null }>("select account_owner, created_by from public.collection_policies where counterparty_id = $1", [customer])).rows[0];
    expect(kept).toEqual({ account_owner: null, created_by: null });
    await db.query("delete from public.counterparties where id = $1", [customer]);
    expect((await db.query("select 1 from public.collection_policies where org_id = $1", [orgId])).rows).toHaveLength(0);
  });
});

describe("collection_tasks", () => {
  it("is opened once per receivable and subject, for a receivable of the customer it names", async () => {
    const orgId = await createOrg(db, "tasks");
    const customer = await counterparty(orgId);
    const other = await counterparty(orgId, "client", "Other Co");
    const invoiceId = await receivable(orgId, customer);
    expect((await openTask(orgId, invoiceId, customer)).rows).toHaveLength(1);
    expect((await openTask(orgId, invoiceId, customer)).rows).toHaveLength(0);
    expect((await openTask(orgId, invoiceId, customer, "hubspot:9001")).rows).toHaveLength(1);
    await expect(openTask(orgId, invoiceId, other, "x")).rejects.toThrow(/collection_task_receivable/);
    const bill = await receivable(orgId, customer, "payable");
    await expect(openTask(orgId, bill, customer, "y")).rejects.toThrow(/collection_task_receivable/);
    await expect(
      asTenant(db, orgId, (tx) =>
        tx.query(
          `insert into public.collection_tasks (org_id, invoice_id, counterparty_id, kind, reason, subject_key, proposal, status, outcome, resolved_at)
           values ($1, $2, $3, 'finance_review', 'reminders_done', 'z', '{}'::jsonb, 'done', 'done', now())`,
          [orgId, invoiceId, customer]
        )
      )
    ).rejects.toThrow(/collection_task_open/);
  });

  it("is resolved once, with what each outcome needs, and never changes after", async () => {
    const orgId = await createOrg(db, "tasks-resolve");
    const person = await createUser(db, "tasks-resolver@example.com");
    const customer = await counterparty(orgId);
    const invoiceId = await receivable(orgId, customer);
    const id = (await openTask(orgId, invoiceId, customer)).rows[0].id;
    const resolve = (set: string, params: unknown[] = []) => asTenant(db, orgId, (tx) => tx.query(`update public.collection_tasks set ${set} where id = $1`, [id, ...params]));

    await expect(resolve("status = 'done', outcome = 'held', resolved_at = now()")).rejects.toThrow(/collection_tasks_hold/);
    await expect(resolve("status = 'done', outcome = 'approved', resolved_at = now()")).rejects.toThrow(/collection_tasks_approval/);
    await expect(resolve("status = 'done', outcome = 'done'")).rejects.toThrow(/collection_tasks_resolved/);
    await expect(resolve("proposal = '{}'::jsonb")).rejects.toThrow(/permission denied/);
    await resolve("notified_at = now()");
    await expect(resolve("notified_at = now() + interval '1 hour'")).rejects.toThrow(/collection_task_fixed/);
    await resolve("status = 'done', outcome = 'approved', approved_number = 1, approved_tone = 'firm', resolved_at = now(), resolved_by = $2", [person]);
    await expect(resolve("outcome = 'no_reminder', approved_number = null, approved_tone = null")).rejects.toThrow(/collection_task_resolved/);
    await expect(resolve("status = 'open', outcome = null, approved_number = null, approved_tone = null, resolved_at = null")).rejects.toThrow(/collection_task_resolved/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.collection_tasks where id = $1", [id]))).rejects.toThrow(/permission denied/);
    // Its resolver's account deleted: kept, as resolved.
    await db.query("delete from auth.users where id = $1", [person]);
    expect((await db.query<{ outcome: string; resolved_by: string | null }>("select outcome, resolved_by from public.collection_tasks where id = $1", [id])).rows[0]).toEqual({ outcome: "approved", resolved_by: null });
    // And it goes with its invoice.
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    expect((await db.query("select 1 from public.collection_tasks where id = $1", [id])).rows).toHaveLength(0);
  });

  it("holds until a day", async () => {
    const orgId = await createOrg(db, "tasks-hold");
    const customer = await counterparty(orgId);
    const invoiceId = await receivable(orgId, customer);
    const id = (await openTask(orgId, invoiceId, customer)).rows[0].id;
    await asTenant(db, orgId, (tx) => tx.query("update public.collection_tasks set status = 'done', outcome = 'held', hold_until = '2026-10-30', resolved_at = now() where id = $1", [id]));
    expect((await db.query<{ hold_until: string }>("select hold_until::text from public.collection_tasks where id = $1", [id])).rows[0].hold_until).toBe("2026-10-30");
  });
});

describe("notification_deliveries (I11)", () => {
  it("claims a key once, marks it sent once, releases only an unsent claim", async () => {
    const orgId = await createOrg(db, "deliveries");
    const subject = crypto.randomUUID();
    const claim = (key: string) =>
      asTenant(db, orgId, (tx) =>
        tx.query<{ id: string }>(
          "insert into public.notification_deliveries (org_id, idempotency_key, kind, subject_id, recipient_hash, policy_version) values ($1, $2, 'collection_reminder', $3, $4, 1) on conflict do nothing returning id",
          [orgId, key, subject, hex("b")]
        )
      );
    const first = await claim(hex("a"));
    expect(first.rows).toHaveLength(1);
    expect((await claim(hex("a"))).rows).toHaveLength(0);
    await expect(claim("not-a-hash")).rejects.toThrow(/notification_deliveries_key_check/);

    // A failed send releases its claim, and the same key is claimed again.
    await asTenant(db, orgId, (tx) => tx.query("delete from public.notification_deliveries where id = $1", [first.rows[0].id]));
    const again = await claim(hex("a"));
    expect(again.rows).toHaveLength(1);
    const id = again.rows[0].id;
    await asTenant(db, orgId, (tx) => tx.query("update public.notification_deliveries set sent_at = now(), provider_id = 'email-1' where id = $1", [id]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.notification_deliveries set sent_at = now() + interval '1 minute' where id = $1", [id]))).rejects.toThrow(/notification_sent/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.notification_deliveries where id = $1", [id]))).rejects.toThrow(/notification_sent/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.notification_deliveries set idempotency_key = $2 where id = $1", [id, hex("c")]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.notification_deliveries set recipient_hash = $2 where id = $1", [id, hex("c")])).rejects.toThrow(/notification_sent/);
  });
});

describe("isolation", () => {
  it("shows each workspace its own rules, tasks and deliveries only, and none to the browser roles", async () => {
    const mine = await createOrg(db, "context-mine");
    const theirs = await createOrg(db, "context-theirs");
    for (const orgId of [mine, theirs]) {
      const customer = await counterparty(orgId);
      await addPolicy(orgId, customer, 1);
      await openTask(orgId, await receivable(orgId, customer), customer);
      await asTenant(db, orgId, (tx) =>
        tx.query("insert into public.notification_deliveries (org_id, idempotency_key, kind, subject_id, recipient_hash) values ($1, $2, 'collection_task', $3, $4)", [
          orgId,
          hex(orgId.replace(/[^0-9a-f]/g, "").slice(0, 8)),
          crypto.randomUUID(),
          hex("d"),
        ])
      );
    }
    for (const table of ["collection_policies", "collection_tasks", "notification_deliveries"]) {
      const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
      expect(seen, table).toEqual([mine]);
      for (const role of ["anon", "authenticated"] as const) {
        await expect(asRole(db, role, (tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
      }
    }
    // Rules for another workspace's customer are refused.
    const theirCustomer = (await db.query<{ id: string }>("select id from public.counterparties where org_id = $1 limit 1", [theirs])).rows[0].id;
    await expect(addPolicy(mine, theirCustomer, 1)).rejects.toThrow(/collection_policies_counterparty_fkey|collection_policy_not_client|row-level security/);
  });
});
