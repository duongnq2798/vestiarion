import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { LEDGER_PAGE_SIZE, readLedgerRows, verifyLedger, type LedgerEntryInput } from "@/lib/ledger";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { buildChain } from "./support/ledger-chain";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * PostgREST answers at most `max_rows` (1,000 on Supabase) per request, so a
 * chain read in one request silently stops at its first page. The ledger is
 * read by seq in pages until a page comes back short (audit-export spec E3).
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000e0e0";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const LEDGER_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const saved = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = saved;
});

const inputs = (n: number): LedgerEntryInput[] =>
  Array.from({ length: n }, (_, i) => ({ actor: "agent", domain: "ap", action: "ap_pay", summary: `entry ${i + 1}`, detail: { i } }));

function ledgerFake(rows: ReturnType<typeof buildChain>) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", wallet_host: null,
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null, circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/ledger_entries") {
      // Answer the way PostgREST does: rows after `seq=gt.N`, ascending, at most `limit`.
      const after = Number((request.params.get("seq") ?? "gt.0").replace(/^gt\./, ""));
      const limit = Number(request.params.get("limit") ?? rows.length);
      return { body: rows.filter((row) => row.seq > after).slice(0, limit) };
    }
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

describe("readLedgerRows", () => {
  it("reads every page, by seq, until a page comes back short", async () => {
    const rows = buildChain(inputs(LEDGER_PAGE_SIZE * 2 + 5), privateKey);
    const { fake, run } = ledgerFake(rows);

    const read = await run(() => readLedgerRows());

    expect(read.map((row) => row.seq)).toEqual(rows.map((row) => row.seq));
    const pages = fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries");
    expect(pages.map((request) => request.params.get("seq"))).toEqual(["gt.0", `gt.${LEDGER_PAGE_SIZE}`, `gt.${LEDGER_PAGE_SIZE * 2}`]);
    for (const page of pages) {
      expect(page.params.get("order")).toBe("seq.asc");
      expect(page.params.get("limit")).toBe(String(LEDGER_PAGE_SIZE));
    }
  });

  it("makes one request for an empty chain", async () => {
    const { fake, run } = ledgerFake([]);
    await expect(run(() => readLedgerRows())).resolves.toEqual([]);
    expect(fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries")).toHaveLength(1);
  });
});

describe("verifyLedger", () => {
  it("checks entries past the first page", async () => {
    const rows = buildChain(inputs(LEDGER_PAGE_SIZE + 3), privateKey);
    const { run } = ledgerFake(rows);
    await expect(run(() => verifyLedger())).resolves.toMatchObject({ valid: true, checkedEntries: LEDGER_PAGE_SIZE + 3 });
  });

  it("finds a break on the second page", async () => {
    const rows = buildChain(inputs(LEDGER_PAGE_SIZE + 3), privateKey);
    rows[LEDGER_PAGE_SIZE + 1] = { ...rows[LEDGER_PAGE_SIZE + 1], summary: "rewritten" };
    const { run } = ledgerFake(rows);
    await expect(run(() => verifyLedger())).resolves.toMatchObject({ valid: false, brokenAt: LEDGER_PAGE_SIZE + 2 });
  });
});
