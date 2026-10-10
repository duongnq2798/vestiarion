import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0099: the team's growth tables, the lead trail its trigger writes, a workspace's first touch, and
 * growth_workspaces, which splits customers from ours as open_funnel does (0089) and works out each workspace's first
 * decision and second real bill by the same definitions.
 */

const TABLES = ["growth_campaigns", "growth_leads", "growth_lead_events", "growth_spend", "growth_revenue", "org_attribution"] as const;
const FUNCTIONS = ["growth_team_member", "growth_update_lead", "growth_import_leads", "record_org_attribution", "growth_workspaces"] as const;

interface Workspace {
  orgId: string;
  slug: string;
  network: string;
  side: "customers" | "ours";
  mode: string;
  shadow: boolean;
  attribution: Record<string, string | null> | null;
  lead: { id: string; source: string; campaignId: string | null } | null;
  firstRealBillAt: string | null;
  realBills: number;
  realBillsWithin7dOfFirst: number;
  firstDecisionAt: string | null;
  verdictsGiven: number;
  verdictsAgreed: number;
  livePayments: number;
  liveUsdc: number;
  members: number;
}

let db: PGlite;
let seq = 0;
let team: string;
let owner: string;

async function org(slug: string, createdBy: string | null, opened: string, network = "arc-testnet"): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by, created_at, network) values ($1, $1, 'sandbox', $2, $3, $4) returning id",
    [slug, createdBy, opened, network]
  );
  if (createdBy) await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [result.rows[0].id, createdBy]);
  return result.rows[0].id;
}

async function payable(orgId: string, name: string, createdAt: string, sample = false): Promise<string> {
  const counterparty = await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, sample) values ($1, $2, 'vendor', $3) returning id", [
    orgId,
    name,
    sample,
  ]);
  const invoice = await db.query<{ id: string }>(
    "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, created_at) values ($1, 'payable', $2, 10, '2026-10-20T00:00:00Z', 'held', $3) returning id",
    [orgId, counterparty.rows[0].id, createdAt]
  );
  return invoice.rows[0].id;
}

async function decision(orgId: string, invoiceId: string, at: string): Promise<void> {
  await db.query(
    `insert into public.ledger_entries (org_id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash)
     values ($1, $2, 'agent', 'ap', 'ap_hold', 'hold', $3, 'b', 's', 'p', gen_random_uuid()::text)`,
    [orgId, at, JSON.stringify({ invoiceId })]
  );
}

async function payment(orgId: string, invoiceId: string, amount: number): Promise<void> {
  await db.query(
    `insert into public.payment_intents
       (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain)
     values ($1, 'invoice', $2, gen_random_uuid()::text, 'circle', 'live', $3, '0xAAA', 'confirmed', '2026-10-05T00:00:00Z', '0xtx', 'ARC-TESTNET')`,
    [orgId, invoiceId, amount]
  );
}

async function verdict(orgId: string, invoiceId: string, value: "agree" | "disagree"): Promise<void> {
  seq += 1;
  await db.query(
    "insert into public.decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict) values ($1, $2, 'invoice', $3, 'ap_hold', $4)",
    [orgId, seq, invoiceId, value]
  );
}

async function lead(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const columns = { business_name: name, source: "signal_outbound", dedupe_key: name.toLowerCase(), ...extra };
  const keys = Object.keys(columns);
  const result = await db.query<{ id: string }>(
    `insert into public.growth_leads (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(columns)
  );
  return result.rows[0].id;
}

const events = async (leadId: string) =>
  (
    await db.query<{ field: string; old_value: string | null; new_value: string | null; note: string | null; by_user: string | null }>(
      "select field, old_value, new_value, note, by_user from public.growth_lead_events where lead_id = $1 order by id",
      [leadId]
    )
  ).rows;

const workspaces = async (since: string | null): Promise<Workspace[]> =>
  (await db.query<{ w: Workspace[] }>("select public.growth_workspaces($1::timestamptz) as w", [since])).rows[0].w;

let customerSlow: string;
let customerRepeat: string;
let customerIdle: string;
let ours: string;
let orphan: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  team = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  owner = await createUser(db, "owner@customer.test");
  const colleague = await createUser(db, "colleague@customer.test");

  // A real bill, the agent's decision 45 minutes after opening, a second real bill 10 days later (outside 7 days), and a
  // sample bill that never counts.
  customerSlow = await org("cust-slow", owner, "2026-10-01T10:00:00Z");
  const slowFirst = await payable(customerSlow, "Hetzner", "2026-10-01T10:30:00Z");
  await decision(customerSlow, slowFirst, "2026-10-01T10:45:00Z");
  await payable(customerSlow, "Hetzner again", "2026-10-11T10:30:00Z");
  const slowSample = await payable(customerSlow, "Sample Vendor", "2026-10-01T10:05:00Z", true);
  await decision(customerSlow, slowSample, "2026-10-01T10:06:00Z");
  await payment(customerSlow, slowSample, 99);

  // Two real bills within 7 days, paid live, two verdicts (one agreeing), a second person, shadow mode, a first touch.
  customerRepeat = await org("cust-repeat", owner, "2026-10-03T08:00:00Z");
  const repeatFirst = await payable(customerRepeat, "Contabo", "2026-10-03T09:00:00Z");
  const repeatSecond = await payable(customerRepeat, "DigitalOcean", "2026-10-06T09:00:00Z");
  await decision(customerRepeat, repeatFirst, "2026-10-03T09:10:00Z");
  await payment(customerRepeat, repeatFirst, 12.5);
  await payment(customerRepeat, repeatSecond, 7.5);
  await verdict(customerRepeat, repeatFirst, "agree");
  await verdict(customerRepeat, repeatSecond, "disagree");
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'approver')", [customerRepeat, colleague]);
  await db.query("insert into public.shadow_modes (org_id, currency) values ($1, 'USD')", [customerRepeat]);

  customerIdle = await org("cust-idle", owner, "2026-10-04T00:00:00Z", "arc-mainnet");
  ours = await org("ours-ws", team, "2026-10-02T00:00:00Z");
  // A workspace whose creator deleted their account counts as ours, as in 0037 and 0089.
  orphan = await org("orphan-ws", null, "2026-10-02T12:00:00Z");
  await org("before-since", owner, "2026-09-20T00:00:00Z");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("the growth tables (0099)", () => {
  it("keep row level security on and nothing for the browser roles", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) order by relname",
      [[...TABLES]]
    );
    expect(rows.map((row) => row.relname)).toEqual([...TABLES].sort());
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
    for (const role of ["anon", "authenticated"] as const) {
      for (const table of TABLES) {
        await expect(asRole(db, role, (tx) => tx.query(`select * from public.${table}`)), `${role} ${table}`).rejects.toThrow(/permission denied/);
      }
      await expect(
        asRole(db, role, (tx) => tx.query("insert into public.growth_leads (business_name, source, dedupe_key) values ('X', 'other', 'x-browser')"))
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("run every function for the service role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.growth_workspaces(null)"))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select public.growth_team_member(gen_random_uuid())"))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select public.record_org_attribution(gen_random_uuid(), '{}'::jsonb)"))).rejects.toThrow(
        /permission denied/
      );
    }
    const { rows } = await db.query<{ routine_name: string }>(
      `select routine_name from information_schema.routine_privileges
        where routine_schema = 'public' and routine_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC')`,
      [[...FUNCTIONS]]
    );
    expect(rows).toEqual([]);
    const definer = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      "select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)",
      [[...FUNCTIONS]]
    );
    expect(definer.rows).toHaveLength(FUNCTIONS.length);
    for (const fn of definer.rows) {
      expect(fn.prosecdef, fn.proname).toBe(true);
      expect(fn.proconfig, fn.proname).toEqual(['search_path=""']);
    }
  });

  it("re-run cleanly, as scripts/migrate.ts re-runs every file", async () => {
    await expect(applyMigrations(db, (file) => file.startsWith("0099"))).resolves.toBeUndefined();
  });

  it("know who is on the team", async () => {
    const member = async (user: string) => (await asServiceRole(db, (tx) => tx.query<{ m: boolean }>("select public.growth_team_member($1) as m", [user]))).rows[0].m;
    expect(await member(team)).toBe(true);
    expect(await member(owner)).toBe(false);
  });
});

describe("the lead trail", () => {
  it("logs a lead's creation and each tracked change, with the note and who made it", async () => {
    const leadId = await lead("Trail Studio");
    await db.query("insert into public.growth_campaigns (id, name) values ('agency-oct', 'Agencies in October')");
    await asServiceRole(db, (tx) =>
      tx.query("select public.growth_update_lead($1, $2::jsonb, $3, $4)", [leadId, JSON.stringify({ stage: "qualified", campaign_id: "agency-oct" }), "fits", team])
    );
    // A write that names no note leaves none behind from the call before it.
    await asServiceRole(db, (tx) => tx.query("select public.growth_update_lead($1, $2::jsonb, null, null)", [leadId, JSON.stringify({ review_status: "rejected" })]));
    // A key the call does not name is left as it is.
    await asServiceRole(db, (tx) => tx.query("select public.growth_update_lead($1, '{}'::jsonb, 'nothing', $2)", [leadId, team]));

    expect(await events(leadId)).toEqual([
      { field: "created", old_value: null, new_value: "discovered", note: null, by_user: null },
      { field: "stage", old_value: "discovered", new_value: "qualified", note: "fits", by_user: team },
      { field: "campaign_id", old_value: null, new_value: "agency-oct", note: "fits", by_user: team },
      { field: "review_status", old_value: "needs_review", new_value: "rejected", note: null, by_user: null },
    ]);
    const row = (await db.query<{ stage: string; campaign_id: string; review_status: string }>("select stage, campaign_id, review_status from public.growth_leads where id = $1", [leadId])).rows[0];
    expect(row).toEqual({ stage: "qualified", campaign_id: "agency-oct", review_status: "rejected" });
  });

  it("logs a workspace link, and its clearing when the workspace is deleted", async () => {
    const victim = await org("doomed-ws", null, "2026-10-05T00:00:00Z");
    const leadId = await lead("Linked Co");
    await asServiceRole(db, (tx) => tx.query("select public.growth_update_lead($1, $2::jsonb, 'signed up', $3)", [leadId, JSON.stringify({ org_id: victim }), team]));
    await db.query("delete from public.orgs where id = $1", [victim]);
    const trail = await events(leadId);
    expect(trail.slice(1)).toEqual([
      { field: "org_id", old_value: null, new_value: victim, note: "signed up", by_user: team },
      { field: "org_id", old_value: victim, new_value: null, note: null, by_user: null },
    ]);
  });

  it("refuses to update, delete or truncate an event, but goes with its lead", async () => {
    const leadId = await lead("Immutable Ltd");
    await expect(asServiceRole(db, (tx) => tx.query("update public.growth_lead_events set note = 'rewritten' where lead_id = $1", [leadId]))).rejects.toThrow(/append-only/);
    await expect(asServiceRole(db, (tx) => tx.query("delete from public.growth_lead_events where lead_id = $1", [leadId]))).rejects.toThrow(/append-only/);
    await expect(asServiceRole(db, (tx) => tx.query("truncate public.growth_lead_events"))).rejects.toThrow(/append-only/);
    expect(await events(leadId)).toHaveLength(1);

    await asServiceRole(db, (tx) => tx.query("delete from public.growth_leads where id = $1", [leadId]));
    expect(await events(leadId)).toHaveLength(0);
  });

  it("imports only leads whose dedupe key is free, never overwriting one, and only as discovered or verified", async () => {
    await lead("Existing Agency", { dedupe_key: "existing.example", notes: "kept" });
    const rows = [
      { business_name: "Existing Agency renamed", source: "directory", dedupe_key: "existing.example", notes: "overwrite?" },
      { business_name: "Fresh Agency", source: "directory", dedupe_key: "fresh.example", stage: "verified", evidence_url: "https://fresh.example/post", evidence_date: "2026-10-01" },
      { business_name: "Sneaky", source: "directory", dedupe_key: "sneaky.example", stage: "paying_customer" },
    ];
    const added = (await asServiceRole(db, (tx) => tx.query<{ a: string[] }>("select public.growth_import_leads($1::jsonb, $2) as a", [JSON.stringify(rows), team]))).rows[0].a;
    expect(added).toEqual(["fresh.example"]);
    const kept = (await db.query<{ notes: string }>("select notes from public.growth_leads where dedupe_key = 'existing.example'")).rows[0];
    expect(kept.notes).toBe("kept");
    const fresh = (await db.query<{ id: string; stage: string; review_status: string }>("select id, stage, review_status from public.growth_leads where dedupe_key = 'fresh.example'")).rows[0];
    expect(fresh).toMatchObject({ stage: "verified", review_status: "needs_review" });
    expect(await events(fresh.id)).toEqual([{ field: "created", old_value: null, new_value: "verified", note: "imported", by_user: team }]);
  });

  it("holds the enums and checks", async () => {
    await expect(lead("Bad stage", { dedupe_key: "bad-stage", stage: "won" })).rejects.toThrow(/growth_leads_stage_check/);
    await expect(lead("Bad source", { dedupe_key: "bad-source", source: "cold_spam" })).rejects.toThrow(/growth_leads_source_check/);
    await expect(db.query("insert into public.growth_campaigns (id, name) values ('Bad Slug', 'x')")).rejects.toThrow(/growth_campaigns_id_check/);
    await expect(db.query("insert into public.growth_campaigns (id, name, strategies) values ('too-far', 'x', '{51}')")).rejects.toThrow(/strategies_check/);
    await expect(db.query("insert into public.growth_spend (spent_on, usd) values ('2026-10-01', -1)")).rejects.toThrow(/growth_spend_usd_check/);
    await expect(db.query("insert into public.growth_revenue (kind, occurred_on) values ('handshake', '2026-10-01')")).rejects.toThrow(/growth_revenue_kind_check/);
  });
});

describe("record_org_attribution", () => {
  const record = (orgId: string, attr: Record<string, unknown>) =>
    asServiceRole(db, (tx) => tx.query<{ r: boolean }>("select public.record_org_attribution($1, $2::jsonb) as r", [orgId, JSON.stringify(attr)])).then(
      (result) => result.rows[0].r
    );

  it("keeps the first touch and never replaces it", async () => {
    expect(await record(customerRepeat, { utm_source: "linkedin", utm_campaign: "agency-oct", landing_path: "/", first_seen_at: "2026-10-02T09:00:00.000Z" })).toBe(true);
    expect(await record(customerRepeat, { utm_source: "x", utm_campaign: "later" })).toBe(false);
    const row = (await db.query<{ utm_source: string; utm_campaign: string; first_seen_at: Date }>("select * from public.org_attribution where org_id = $1", [customerRepeat])).rows[0];
    expect(row.utm_source).toBe("linkedin");
    expect(row.utm_campaign).toBe("agency-oct");
    expect(row.first_seen_at.toISOString()).toBe("2026-10-02T09:00:00.000Z");
  });

  it("cuts each value to 100 characters and drops a time it cannot read", async () => {
    expect(await record(customerSlow, { utm_source: "a".repeat(300), first_seen_at: "yesterday" })).toBe(true);
    const row = (await db.query<{ utm_source: string; first_seen_at: Date | null }>("select * from public.org_attribution where org_id = $1", [customerSlow])).rows[0];
    expect(row.utm_source).toHaveLength(100);
    expect(row.first_seen_at).toBeNull();
  });
});

describe("growth_workspaces", () => {
  it("splits customers from ours as open_funnel does", async () => {
    const list = await workspaces("2026-09-27T00:00:00Z");
    const side = (id: string) => list.find((w) => w.orgId === id)?.side;
    expect(side(customerSlow)).toBe("customers");
    expect(side(customerRepeat)).toBe("customers");
    expect(side(customerIdle)).toBe("customers");
    expect(side(ours)).toBe("ours");
    expect(side(orphan)).toBe("ours");
    expect(list.some((w) => w.slug === "before-since")).toBe(false);
    // The same customers' count open_funnel gives, network by network.
    for (const network of ["arc-testnet", "arc-mainnet"]) {
      const funnel = (await db.query<{ f: { sides: { customers: { opened: number } } } }>("select public.open_funnel('2026-09-27T00:00:00Z', $1) as f", [network])).rows[0].f;
      expect(list.filter((w) => w.network === network && w.side === "customers")).toHaveLength(Number(funnel.sides.customers.opened));
    }
  });

  it("works out the first real bill, the first decision on one, and the second real bill within 7 days", async () => {
    const list = await workspaces("2026-09-27T00:00:00Z");
    const slow = list.find((w) => w.orgId === customerSlow)!;
    expect(new Date(slow.firstRealBillAt!).toISOString()).toBe("2026-10-01T10:30:00.000Z");
    expect(new Date(slow.firstDecisionAt!).toISOString()).toBe("2026-10-01T10:45:00.000Z");
    expect(Number(slow.realBills)).toBe(2);
    expect(Number(slow.realBillsWithin7dOfFirst)).toBe(1);
    // The sample bill's payment never counts.
    expect(Number(slow.livePayments)).toBe(0);

    const repeat = list.find((w) => w.orgId === customerRepeat)!;
    expect(Number(repeat.realBillsWithin7dOfFirst)).toBe(2);
    expect(Number(repeat.livePayments)).toBe(2);
    expect(Number(repeat.liveUsdc)).toBe(20);
    expect(Number(repeat.verdictsGiven)).toBe(2);
    expect(Number(repeat.verdictsAgreed)).toBe(1);
    expect(Number(repeat.members)).toBe(2);
    expect(repeat.shadow).toBe(true);
    expect(repeat.attribution).toMatchObject({ utmSource: "linkedin", utmCampaign: "agency-oct" });

    const idle = list.find((w) => w.orgId === customerIdle)!;
    expect(idle).toMatchObject({ network: "arc-mainnet", firstRealBillAt: null, firstDecisionAt: null, shadow: false, attribution: null, lead: null });
  });

  it("names the lead the team linked, and no person", async () => {
    const leadId = await lead("Repeat Co", { dedupe_key: "repeat.example", source: "warm_intro" });
    await asServiceRole(db, (tx) => tx.query("select public.growth_update_lead($1, $2::jsonb, null, $3)", [leadId, JSON.stringify({ org_id: customerRepeat }), team]));
    const list = await asServiceRole(db, (tx) => tx.query<{ w: Workspace[] }>("select public.growth_workspaces(null) as w")).then((r) => r.rows[0].w);
    expect(list.find((w) => w.orgId === customerRepeat)?.lead).toEqual({ id: leadId, source: "warm_intro", campaignId: null });
    expect(JSON.stringify(list)).not.toMatch(/@customer\.test|@vestiarion\.test/);
  });
});
