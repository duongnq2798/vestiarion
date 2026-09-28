import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { NoOrgScopeError, runWith } from "@/lib/context";
import { getChainProvider } from "@/lib/circle";
import { getInsightsData } from "@/lib/insights";
import { getLandingMetrics } from "@/lib/landing";
import {
  appendLedgerEntry,
  ledgerEntryCount,
  ledgerPublicKeyPem,
  ledgerReadWarnings,
  listLedgerEntries,
  listLedgerEntriesAfter,
  listLedgerEntriesByDomain,
  listLedgerEntriesForTargets,
  listLedgerEntryPage,
  verifyLedger,
} from "@/lib/ledger";
import { latestForecast, listAccounts, listCounterparties, listInvoices, listMilestones, listTreasuryActions, stats } from "@/lib/queries";
import { LedgerSigningKeyError } from "@/lib/ledger-keys";
import { carriesOrg, fakeSupabase } from "./support/fake-supabase";

/**
 * Every library function that touches tenant data: outside an organization it
 * refuses before any request, and inside one every request it makes names that
 * organization.
 *
 * The organization contexts here are built by hand in the shape `contextFor`
 * builds them, `platformConfig` included — without it `currentOrgConfig()`
 * refuses (R19), and a read that reaches for the organization's keys would
 * stop there instead of running to the end.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const READS: Array<[string, () => Promise<unknown>]> = [
  ["listAccounts", () => listAccounts()],
  ["listCounterparties", () => listCounterparties()],
  ["listInvoices", () => listInvoices()],
  ["listMilestones", () => listMilestones()],
  ["listTreasuryActions", () => listTreasuryActions()],
  ["latestForecast", () => latestForecast()],
  ["stats", () => stats()],
  ["listLedgerEntries", () => listLedgerEntries(5)],
  ["listLedgerEntriesAfter", () => listLedgerEntriesAfter(1)],
  ["listLedgerEntriesByDomain", () => listLedgerEntriesByDomain("treasury", 2)],
  ["listLedgerEntriesForTargets", () => listLedgerEntriesForTargets({ invoiceIds: ["i1"] })],
  ["listLedgerEntryPage", () => listLedgerEntryPage({ limit: 10 })],
  ["ledgerEntryCount", () => ledgerEntryCount()],
  ["verifyLedger", () => verifyLedger()],
  ["getInsightsData", () => getInsightsData()],
  ["getLandingMetrics", () => getLandingMetrics()],
];

describe.each(READS)("%s", (_name, read) => {
  it("refuses outside an organization, before any request", async () => {
    const fake = fakeSupabase();
    await expect(runWith({ config, db: fake.client }, read)).rejects.toThrow(NoOrgScopeError);
    expect(fake.requests).toEqual([]);
  });

  it("names the organization on every request it makes", async () => {
    const fake = fakeSupabase();
    await runWith({ config, db: fake.client, orgId: ORG, platformConfig: config }, read).catch(() => undefined);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) expect(carriesOrg(request, ORG), `${request.method} ${request.path}`).toBe(true);
  });
});

describe("an organization's secrets", () => {
  it("are never read outside its scope", () => {
    runWith({ config, db: fakeSupabase().client }, () => {
      expect(() => getChainProvider()).toThrow(NoOrgScopeError);
      expect(() => ledgerPublicKeyPem()).toThrow(NoOrgScopeError);
      expect(() => ledgerReadWarnings()).toThrow(NoOrgScopeError);
    });
  });

  it("surface a stored secret that could not be read as a ledger warning", () => {
    runWith({ config, db: fakeSupabase().client, orgId: ORG, secretWarnings: ["could not decrypt ledger_signing_key_enc"], platformConfig: config }, () => {
      expect(ledgerReadWarnings()).toContain("could not decrypt ledger_signing_key_enc");
    });
  });

  it("make appending fail loudly when the organization has no signing key", async () => {
    const scopedConfig = { ...config, ledgerSigningKey: undefined, allowGeneratedLedgerKey: false };
    const fake = fakeSupabase();
    await expect(
      runWith({ config: scopedConfig, db: fake.client, orgId: ORG, platformConfig: config }, () =>
        appendLedgerEntry({ actor: "system", domain: "system", action: "note", summary: "x", detail: {} })
      )
    ).rejects.toThrow(LedgerSigningKeyError);
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });

  it("never invents a key on demand, even where this deployment allows a generated one — an organization's key is created only with the organization", async () => {
    const scopedConfig = { ...config, ledgerSigningKey: undefined, allowGeneratedLedgerKey: true };
    const fake = fakeSupabase();
    await expect(
      runWith({ config: scopedConfig, db: fake.client, orgId: ORG, platformConfig: config }, () =>
        appendLedgerEntry({ actor: "system", domain: "system", action: "note", summary: "x", detail: {} })
      )
    ).rejects.toThrow(/created with the organization, never on demand/);
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });
});
