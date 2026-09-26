import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHashOf, verifyChain, type LedgerEntryInput, type LedgerRow } from "@/lib/ledger";
import { ledgerKeyId, type LedgerKeyring } from "@/lib/ledger-keys";

/**
 * The one place the database and the verifier are made to agree.
 *
 * `tests/ledger.test.ts` rebuilds the chain-linking logic in TypeScript and
 * verifies chains it built itself. For a long time its header claimed a
 * parity test pinned the Postgres side; no such file existed, so if
 * `append_ledger_entry()` and `verifyChain()` had ever drifted, every test
 * would have kept passing while the real ledger stopped verifying.
 *
 * This file runs the real migrations, unmodified, on a real Postgres — PGlite,
 * Postgres compiled to WebAssembly, in this process — then appends through the
 * real `append_ledger_entry()` and hands the rows it stored to the same
 * `verifyChain()` the application uses. Nothing is reimplemented on either
 * side. If the SQL changes the way it links, or the verifier changes what it
 * expects, this is what turns red.
 *
 * Supabase provides three roles the migrations grant and revoke against; a
 * vanilla Postgres has none of them, so they are created first. That is the
 * only thing done here that the migrations do not do themselves.
 */

const GENESIS = "0".repeat(64);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create role anon; create role authenticated; create role service_role;");

  const dir = path.join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(dir, file), "utf8"));
  }
}, 60_000);

afterAll(async () => {
  await db.close();
});

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

function ring(active: crypto.KeyObject | null, ...retired: crypto.KeyObject[]): LedgerKeyring {
  return { active, retired };
}

/** Signs the way `appendLedgerEntry` does and hands the body to the database to link. */
async function appendThroughPostgres(
  input: LedgerEntryInput,
  privateKey: crypto.KeyObject,
  signingKeyId: string | null = ledgerKeyId(privateKey)
): Promise<LedgerRow> {
  const bodyHash = bodyHashOf(input);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const result = await db.query<LedgerRow>(
    "select * from append_ledger_entry($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
    [input.actor, input.domain, input.action, input.summary, JSON.stringify(input.detail), bodyHash, signature, signingKeyId]
  );
  return result.rows[0];
}

async function storedChain(): Promise<LedgerRow[]> {
  const result = await db.query<LedgerRow>("select * from ledger_entries order by seq asc");
  return result.rows;
}

const ENTRIES: LedgerEntryInput[] = [
  {
    actor: "agent",
    domain: "compliance",
    action: "screen_counterparty",
    summary: "Screened Zenith Trading LLC: high risk",
    detail: { riskLevel: "high", newPaymentLimit: 0 },
  },
  {
    actor: "agent",
    domain: "ap",
    action: "pay_invoice",
    summary: "Paid INV-1042 to Meridian Works, 12.5 USDC",
    detail: { amount: 12.5, txRef: "0xabc" },
  },
  {
    actor: "human",
    domain: "contractor",
    action: "verify_milestone",
    summary: "Verified milestone 2 by hand",
    detail: { note: "Reviewed the merged PR" },
  },
];

/** Signs the first three entries; shared so the second block can keep the chain checkable. */
const key = keypair();

describe("append_ledger_entry() agrees with verifyChain()", () => {

  it("links the first entry to a genesis of zeros", async () => {
    const row = await appendThroughPostgres(ENTRIES[0], key.privateKey);

    expect(row.prev_hash).toBe(GENESIS);
    expect(verifyChain([row], ring(key.publicKey))).toEqual({ valid: true, checkedEntries: 1 });
  });

  it("produces a chain the application's verifier accepts", async () => {
    // The database links each entry; the verifier recomputes every link. If
    // the two ever disagree about what a link is, this is the assertion that
    // says so — nothing else in the suite can.
    await appendThroughPostgres(ENTRIES[1], key.privateKey);
    await appendThroughPostgres(ENTRIES[2], key.privateKey);

    const rows = await storedChain();
    expect(rows).toHaveLength(3);
    expect(verifyChain(rows, ring(key.publicKey))).toEqual({ valid: true, checkedEntries: 3 });
  });

  it("stores the signing key id it was given", async () => {
    const rows = await storedChain();
    for (const row of rows) expect(row.signing_key_id).toBe(ledgerKeyId(key.publicKey));
  });

  it("honours the key id the database stored", async () => {
    // Every row above is labelled with `key`. A ring that does not hold that
    // key cannot check them, and the verifier must say exactly that — not
    // "signature does not verify", which would read as forgery. This proves
    // the label survived the round trip through Postgres and is acted on.
    const stranger = keypair();
    const result = verifyChain(await storedChain(), ring(stranger.publicKey));

    expect(result.valid).toBeNull();
    expect(result.brokenAt).toBeUndefined();
    expect(result.reason).toContain(ledgerKeyId(key.publicKey));
  });
});

describe("migration 0014 on a real Postgres", () => {
  it("leaves exactly one append_ledger_entry, so a caller cannot reach an older shape", async () => {
    // PostgREST resolves an RPC by name and argument names. Two overloads would
    // let a caller silently land on the one that records no key. This was
    // observed by hand on production when the migration was applied; here it
    // is pinned.
    const result = await db.query<{ args: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'append_ledger_entry'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].args).toContain("p_signing_key_id");
  });

  it("records null for a caller that sends no key id, as pre-identity code did", async () => {
    const legacy = keypair();
    const row = await appendThroughPostgres(
      { actor: "system", domain: "system", action: "legacy_append", summary: "No key id supplied", detail: {} },
      legacy.privateKey,
      null
    );
    expect(row.signing_key_id).toBeNull();

    // An unlabelled row is checked against every key in the ring, which is how
    // all pre-migration history reads. Without `legacy` in the ring the chain
    // breaks on this row's *signature* — the one assertion in the suite that
    // proves rows out of Postgres carry real authorship and not merely links.
    const rows = await storedChain();
    expect(rows).toHaveLength(4);

    const withoutLegacy = verifyChain(rows, ring(key.publicKey));
    expect(withoutLegacy.valid).toBe(false);
    expect(withoutLegacy.brokenAt).toBe(4);
    expect(withoutLegacy.reason).toMatch(/signature/);

    expect(verifyChain(rows, ring(key.publicKey, legacy.publicKey))).toEqual({ valid: true, checkedEntries: 4 });
  });
});
