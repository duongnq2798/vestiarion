import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0113 (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M4-M7): a workspace's reporting
 * currency, the rates it used with their kind, source and time, the FX variance on a paid bill, and saved cash scenario
 * versions. Each seen and written only by its own workspace; a rate, a variance and a version never changed in place.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0113_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function payable(orgId: string): Promise<string> {
  const counterparty = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Supplier', 'vendor') returning id", [orgId])).rows[0].id;
  return (
    await db.query<{ id: string }>(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1000, now()) returning id",
      [orgId, counterparty]
    )
  ).rows[0].id;
}

async function rate(orgId: string, fields: Partial<{ base: string; quote: string; rate: number; kind: string; source: string; published_at: string; scenario_version_id: string | null }> = {}): Promise<string> {
  const row = { base: "USD", quote: "SGD", rate: 1.36, kind: "reference", source: "ExchangeRate-API", published_at: "2026-10-12T00:02:00Z", scenario_version_id: null, ...fields };
  return (
    await db.query<{ id: string }>(
      "insert into public.fx_rates (org_id, base, quote, rate, kind, source, published_at, scenario_version_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
      [orgId, row.base, row.quote, row.rate, row.kind, row.source, row.published_at, row.scenario_version_id]
    )
  ).rows[0].id;
}

async function version(orgId: string, scenarioId: string, number: number, name = "SGD weakens"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      "insert into public.cash_scenario_versions (org_id, scenario_id, version, name, levers, rates) values ($1, $2, $3, $4, '{\"horizon\": 60}'::jsonb, '[]'::jsonb) returning id",
      [orgId, scenarioId, number, name]
    )
  ).rows[0].id;
}

const VARIANCE = {
  currency: "SGD",
  paid_currency: "USDC",
  paid_amount: "1000",
  paid_at: "2026-10-12T15:00:00Z",
  covered_amount: "1350",
  decision_rate: "1.35",
  decision_source: "ExchangeRate-API",
  decision_at: "2026-10-10T00:02:00Z",
  payment_rate: "1.36",
  payment_source: "ExchangeRate-API",
  payment_rate_at: "2026-10-12T00:02:00Z",
  value_at_payment: "992.65",
  variance: "7.35",
};

async function variance(orgId: string, invoiceId: string, rateId: string, fields: Partial<typeof VARIANCE> = {}): Promise<void> {
  const row = { ...VARIANCE, ...fields };
  await db.query(
    `insert into public.fx_variances (org_id, invoice_id, currency, paid_currency, paid_amount, paid_at, covered_amount, decision_rate, decision_source,
       decision_at, payment_rate_id, payment_rate, payment_source, payment_rate_at, value_at_payment, variance)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [orgId, invoiceId, row.currency, row.paid_currency, row.paid_amount, row.paid_at, row.covered_amount, row.decision_rate, row.decision_source, row.decision_at, rateId, row.payment_rate, row.payment_source, row.payment_rate_at, row.value_at_payment, row.variance]
  );
}

describe("reporting_currencies (0113)", () => {
  it("takes one of the six currencies or the euro, once per workspace, with who set it", async () => {
    const orgId = await createOrg(db, "reporting-currency");
    const person = await createUser(db, "owner-reporting@example.com");
    await db.query("insert into public.reporting_currencies (org_id, currency, set_by) values ($1, 'SGD', $2)", [orgId, person]);
    await expect(db.query("insert into public.reporting_currencies (org_id, currency) values ($1, 'JPY')", [orgId])).rejects.toThrow(/reporting_currencies_pkey/);
    for (const currency of ["USD", "EUR", "JPY", "KRW", "PHP", "MYR"]) await db.query("update public.reporting_currencies set currency = $2 where org_id = $1", [orgId, currency]);
    for (const currency of ["USDC", "EURC", "VND", "GBP", "sgd"]) {
      await expect(db.query("update public.reporting_currencies set currency = $2 where org_id = $1", [orgId, currency])).rejects.toThrow(/reporting_currencies_currency_check/);
    }
  });

  it("lets its own workspace read, set and change it, and never delete it", async () => {
    const orgId = await createOrg(db, "reporting-tenant");
    await asTenant(db, orgId, (tx) => tx.query("insert into public.reporting_currencies (org_id, currency) values ($1, 'USD')", [orgId]));
    await asTenant(db, orgId, (tx) => tx.query("update public.reporting_currencies set currency = 'KRW', set_at = now() where org_id = $1", [orgId]));
    const read = await asTenant(db, orgId, (tx) => tx.query<{ currency: string }>("select currency from public.reporting_currencies"));
    expect(read.rows).toEqual([{ currency: "KRW" }]);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.reporting_currencies set org_id = org_id"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.reporting_currencies"))).rejects.toThrow(/permission denied/);
  });
});

describe("fx_rates (0113)", () => {
  it("keeps a rate with its kind, source and publication, once per kind, source, pair and publication", async () => {
    const orgId = await createOrg(db, "rates-once");
    await rate(orgId);
    await expect(rate(orgId)).rejects.toThrow(/fx_rates_published_once/);
    // Another day, another source or another kind is another rate.
    await rate(orgId, { published_at: "2026-10-13T00:02:00Z" });
    await rate(orgId, { kind: "quote", source: "Circle" });
    const kept = (await db.query<{ rate: string; recorded_at: Date | null }>("select rate::text, recorded_at from public.fx_rates where org_id = $1 and kind = 'reference' order by published_at", [orgId])).rows;
    expect(kept.map((row) => row.rate)).toEqual(["1.360000000000", "1.360000000000"]);
    expect(kept[0].recorded_at).not.toBeNull();
  });

  it("refuses a rate of zero, a pair of one currency, an unknown kind or an empty source", async () => {
    const orgId = await createOrg(db, "rates-checks");
    await expect(rate(orgId, { rate: 0 })).rejects.toThrow(/fx_rates_rate_check/);
    await expect(rate(orgId, { quote: "USD" })).rejects.toThrow(/fx_rates_pair_check/);
    await expect(rate(orgId, { kind: "guess" })).rejects.toThrow(/fx_rates_kind_check/);
    await expect(rate(orgId, { source: "" })).rejects.toThrow(/fx_rates_source_check/);
    await expect(rate(orgId, { quote: "sgd" })).rejects.toThrow(/fx_rates_quote_check/);
  });

  it("names a scenario version only for a rate a person typed, in the same workspace", async () => {
    const orgId = await createOrg(db, "rates-manual");
    const other = await createOrg(db, "rates-manual-other");
    const versionId = await version(orgId, crypto.randomUUID(), 1);
    await rate(orgId, { kind: "manual", source: "Cash scenario", scenario_version_id: versionId, rate: 1.4 });
    await expect(rate(orgId, { kind: "reference", scenario_version_id: versionId, published_at: "2026-10-01T00:00:00Z" })).rejects.toThrow(/fx_rates_manual_scenario/);
    await expect(rate(other, { kind: "manual", source: "Cash scenario", scenario_version_id: versionId })).rejects.toThrow(/fx_rates_scenario_fkey/);
  });

  it("is read and added by its own workspace only, and never changed", async () => {
    const orgId = await createOrg(db, "rates-tenant");
    const other = await createOrg(db, "rates-tenant-other");
    await asTenant(db, orgId, (tx) =>
      tx.query("insert into public.fx_rates (org_id, base, quote, rate, kind, source, published_at) values ($1, 'USD', 'JPY', 149.235, 'reference', 'ExchangeRate-API', now())", [orgId])
    );
    await expect(
      asTenant(db, orgId, (tx) =>
        tx.query("insert into public.fx_rates (org_id, base, quote, rate, kind, source, published_at) values ($1, 'USD', 'JPY', 150, 'reference', 'ExchangeRate-API', now())", [other])
      )
    ).rejects.toThrow(/row-level security/);
    // Recording the same publication again does nothing, as the app's upsert asks.
    await asTenant(db, orgId, (tx) =>
      tx.query(
        "insert into public.fx_rates (org_id, base, quote, rate, kind, source, published_at) select org_id, base, quote, rate, kind, source, published_at from public.fx_rates where quote = 'JPY' on conflict on constraint fx_rates_published_once do nothing"
      )
    );
    expect((await asTenant(db, orgId, (tx) => tx.query("select 1 from public.fx_rates where quote = 'JPY'"))).rows).toHaveLength(1);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.fx_rates set rate = 1"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.fx_rates"))).rejects.toThrow(/permission denied/);
  });
});

describe("fx_variances (0113)", () => {
  it("keeps one variance per paid bill, adding up, with the rate in force at the payment", async () => {
    const orgId = await createOrg(db, "variance-once");
    const invoiceId = await payable(orgId);
    const rateId = await rate(orgId);
    await variance(orgId, invoiceId, rateId);
    await expect(variance(orgId, invoiceId, rateId)).rejects.toThrow(/fx_variances_invoice_key/);
    const kept = (await db.query<{ variance: string; value_at_payment: string }>("select variance::text, value_at_payment::text from public.fx_variances where invoice_id = $1", [invoiceId])).rows;
    expect(kept).toEqual([{ variance: "7.350000", value_at_payment: "992.650000" }]);
  });

  it("refuses a variance that does not add up, a rate published after the payment or more than 36 hours before it", async () => {
    const orgId = await createOrg(db, "variance-checks");
    const rateId = await rate(orgId);
    await expect(variance(orgId, await payable(orgId), rateId, { variance: "7.36" })).rejects.toThrow(/fx_variances_adds_up/);
    await expect(variance(orgId, await payable(orgId), rateId, { paid_at: "2026-10-11T23:00:00Z" })).rejects.toThrow(/fx_variances_rate_in_force/);
    await expect(variance(orgId, await payable(orgId), rateId, { paid_at: "2026-10-13T12:03:00Z" })).rejects.toThrow(/fx_variances_rate_in_force/);
    await variance(orgId, await payable(orgId), rateId, { paid_at: "2026-10-13T12:02:00Z" });
  });

  it("is in USDC, for a bill in a currency other than the dollar", async () => {
    const orgId = await createOrg(db, "variance-currency");
    const rateId = await rate(orgId);
    await expect(variance(orgId, await payable(orgId), rateId, { currency: "USD" })).rejects.toThrow(/fx_variances_currency_check/);
    await expect(variance(orgId, await payable(orgId), rateId, { paid_currency: "EURC" })).rejects.toThrow(/fx_variances_paid_currency_check/);
  });

  it("refuses a bill or a rate of another workspace, and goes with its bill", async () => {
    const orgId = await createOrg(db, "variance-links");
    const other = await createOrg(db, "variance-links-other");
    const rateId = await rate(orgId);
    await expect(variance(other, await payable(other), rateId)).rejects.toThrow(/fx_variances_rate_fkey/);
    await expect(variance(other, await payable(orgId), await rate(other))).rejects.toThrow(/fx_variances_invoice_fkey/);
    const invoiceId = await payable(orgId);
    await variance(orgId, invoiceId, rateId);
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    expect((await db.query("select 1 from public.fx_variances where invoice_id = $1", [invoiceId])).rows).toHaveLength(0);
  });

  it("is read and added by its own workspace only, and never changed", async () => {
    const orgId = await createOrg(db, "variance-tenant");
    const invoiceId = await payable(orgId);
    const rateId = await rate(orgId);
    await asTenant(db, orgId, (tx) =>
      tx.query(
        `insert into public.fx_variances (org_id, invoice_id, currency, paid_currency, paid_amount, paid_at, covered_amount, decision_rate, decision_source,
           decision_at, payment_rate_id, payment_rate, payment_source, payment_rate_at, value_at_payment, variance)
         values ($1, $2, 'SGD', 'USDC', 1000, '2026-10-12T15:00:00Z', 1350, 1.35, 'ExchangeRate-API', '2026-10-10T00:02:00Z', $3, 1.36, 'ExchangeRate-API',
           '2026-10-12T00:02:00Z', 992.65, 7.35)`,
        [orgId, invoiceId, rateId]
      )
    );
    expect((await asTenant(db, orgId, (tx) => tx.query("select 1 from public.fx_variances"))).rows).toHaveLength(1);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.fx_variances set variance = 0, value_at_payment = paid_amount"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.fx_variances"))).rejects.toThrow(/permission denied/);
  });
});

describe("cash_scenario_versions (0113)", () => {
  it("numbers a scenario's versions one after another, never twice and never with a gap", async () => {
    const orgId = await createOrg(db, "scenario-versions");
    const scenarioId = crypto.randomUUID();
    await version(orgId, scenarioId, 1);
    await expect(version(orgId, scenarioId, 1)).rejects.toThrow(/cash_scenario_started|cash_scenario_versions_version_key/);
    await expect(version(orgId, scenarioId, 3)).rejects.toThrow(/cash_scenario_version_gap/);
    await version(orgId, scenarioId, 2, "SGD weakens, later");
    await version(orgId, scenarioId, 3);
    await expect(version(orgId, crypto.randomUUID(), 2)).rejects.toThrow(/cash_scenario_version_gap/);
    // Another workspace's scenario of the same id is its own.
    await version(await createOrg(db, "scenario-versions-other"), scenarioId, 1);
  });

  it("refuses a name that is empty or long, levers that are not an object, rates that are not a list", async () => {
    const orgId = await createOrg(db, "scenario-checks");
    await expect(version(orgId, crypto.randomUUID(), 1, " ")).rejects.toThrow(/cash_scenario_versions_name_check/);
    await expect(version(orgId, crypto.randomUUID(), 1, "x".repeat(81))).rejects.toThrow(/cash_scenario_versions_name_check/);
    await expect(
      db.query("insert into public.cash_scenario_versions (org_id, scenario_id, version, name, levers) values ($1, gen_random_uuid(), 1, 'n', '[]'::jsonb)", [orgId])
    ).rejects.toThrow(/cash_scenario_versions_levers_check/);
    await expect(
      db.query("insert into public.cash_scenario_versions (org_id, scenario_id, version, name, levers, rates) values ($1, gen_random_uuid(), 1, 'n', '{}'::jsonb, '{}'::jsonb)", [orgId])
    ).rejects.toThrow(/cash_scenario_versions_rates_check/);
    await expect(
      db.query("insert into public.cash_scenario_versions (org_id, scenario_id, version, name, levers, reporting_currency) values ($1, gen_random_uuid(), 1, 'n', '{}'::jsonb, 'USDC')", [orgId])
    ).rejects.toThrow(/cash_scenario_versions_reporting_check/);
  });

  it("is read and added by its own workspace only, and never changed", async () => {
    const orgId = await createOrg(db, "scenario-tenant");
    await asTenant(db, orgId, (tx) =>
      tx.query("insert into public.cash_scenario_versions (org_id, scenario_id, version, name, levers) values ($1, gen_random_uuid(), 1, 'Base', '{}'::jsonb)", [orgId])
    );
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.cash_scenario_versions set name = 'changed'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.cash_scenario_versions"))).rejects.toThrow(/permission denied/);
  });
});
