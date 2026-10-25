import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

const { appendEntryMock } = vi.hoisted(() => ({ appendEntryMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  appendLedgerEntry: appendEntryMock,
}));

import { EXPORT_NEVER_DUE, saveConnection } from "@/lib/connectors/connections";
import { accountingProvider, accountingProviderOn } from "@/lib/accounting-providers";
import { BOOKS_PAYMENTS, PICKS_PAYMENT_ACCOUNT } from "@/lib/connectors/booking";
import { PROVIDER_KINDS, PROVIDER_LABELS, PROVIDER_WORDS, providerKind } from "@/lib/connectors/provider";
import { crmProvider } from "@/lib/crm-providers";

/**
 * Google Sheets on the connector core (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS1, GS15):
 * a provider of kind export, which no booking, review or sync path takes; its connection is saved never due, so the
 * sweeper never picks it; and its signed `accounting_connected` says where close packs are exported from.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c02";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const CONSENT = { version: "googlesheets-2026-10-25", at: "2026-10-25T08:59:00.000Z" };
const SCOPE = "https://www.googleapis.com/auth/drive.file";

function scope() {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/accounting_connections" && request.method === "GET") return { body: [] };
    if (request.path === "/rest/v1/accounting_connections" && request.method === "POST") {
      const body = request.body as Record<string, unknown>;
      return {
        body: [
          {
            id: "conn-sheets", org_id: ORG, provider: body.provider, external_org_id: body.external_org_id, external_org_name: body.external_org_name, status: "connected",
            scopes: body.scopes, connected_by: USER, connected_at: body.connected_at, consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null,
            window_from: body.window_from, last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: body.next_sync_after,
            sync_lease_until: null, payment_account: null, payment_account_at: null,
          },
        ],
      };
    }
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

afterEach(() => {
  appendEntryMock.mockReset();
});

describe("the googlesheets provider id (close pack Sheets GS1)", () => {
  it("is an export tool, labelled Google Sheets, in its own words", () => {
    expect(PROVIDER_LABELS.googlesheets).toBe("Google Sheets");
    expect(PROVIDER_KINDS.googlesheets).toBe("export");
    expect(providerKind("Google Sheets")).toBe("export");
    expect(PROVIDER_WORDS.googlesheets).toEqual({
      possessive: "Google Sheets'",
      organisation: "Google account",
      contacts: "no contacts",
      accounts: "no accounts",
      idleDays: 0,
      bills: "close packs",
      approval: "A close pack in Google Sheets is a copy: the signed ledger stays the record.",
    });
  });

  it("is taken by no booking, review or sync path", () => {
    expect(BOOKS_PAYMENTS.googlesheets).toBe(false);
    expect(PICKS_PAYMENT_ACCOUNT.googlesheets).toBe(false);
    expect(accountingProvider("googlesheets")).toBeNull();
    expect(accountingProviderOn("googlesheets")).toBe(false);
    expect(crmProvider("googlesheets")).toBeNull();
  });
});

describe("saveConnection for an export tool (close pack Sheets GS15)", () => {
  it("saves a Google Sheets connection never due, and signs where close packs are exported from", async () => {
    const { fake, run } = scope();
    const saved = await run(() =>
      saveConnection({
        provider: "googlesheets",
        organisation: { externalOrgId: "07623471185212345678", name: "du***@gmail.com", connectionId: null },
        connectedBy: USER,
        scopes: [SCOPE],
        consent: CONSENT,
        nowMs: Date.parse("2026-10-25T09:00:00.000Z"),
      })
    );
    expect(saved).toMatchObject({ ok: true, reconnected: false });
    const insert = fake.requests.find((request: RecordedRequest) => request.path === "/rest/v1/accounting_connections" && request.method === "POST");
    expect(insert?.body).toMatchObject({ provider: "googlesheets", external_org_id: "07623471185212345678", external_org_name: "du***@gmail.com", next_sync_after: EXPORT_NEVER_DUE });
    expect(EXPORT_NEVER_DUE).toBe("9999-12-31T00:00:00.000Z");
    expect(appendEntryMock).toHaveBeenCalledTimes(1);
    expect(appendEntryMock.mock.calls[0][0]).toMatchObject({
      actor: "human",
      domain: "system",
      action: "accounting_connected",
      summary: "Connected Google Sheets: du***@gmail.com. Close packs can be exported to its Google Drive from Monthly close pack",
      detail: { provider: "googlesheets", externalOrgId: "07623471185212345678", externalOrgName: "du***@gmail.com", scopes: [SCOPE], consent: CONSENT, reconnected: false },
    });
  });

  it("keeps every other provider's next sync null, so the sweeper takes it at once", async () => {
    const { fake, run } = scope();
    await run(() =>
      saveConnection({
        provider: "xero",
        organisation: { externalOrgId: "tenant-1", name: "Demo Company", connectionId: null },
        connectedBy: USER,
        scopes: ["accounting.transactions.read"],
        consent: { version: "xero-2026-10-15", at: CONSENT.at },
      })
    );
    const insert = fake.requests.find((request: RecordedRequest) => request.path === "/rest/v1/accounting_connections" && request.method === "POST");
    expect((insert?.body as Record<string, unknown>).next_sync_after).toBeNull();
  });
});
