import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0083 (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md K12): which kind of wallet signs for an
 * owner's treasury, a browser wallet or a passkey, and whether its recovery was registered or skipped.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const RECOVERY = "0x5aF3107A4000000000000000000000000000c0de";

async function freshRow(slug: string): Promise<string> {
  const orgId = await createOrg(db, slug);
  await db.query("delete from public.spending_limit_contracts where org_id = $1", [orgId]);
  await db.query("insert into public.spending_limit_contracts (org_id) values ($1)", [orgId]);
  return orgId;
}

const rowOf = async (orgId: string) =>
  (
    await db.query<{ treasury_signer: string; recovery_address: string | null; recovery_skipped_at: string | null }>(
      "select treasury_signer, recovery_address, recovery_skipped_at from public.spending_limit_contracts where org_id = $1",
      [orgId]
    )
  ).rows[0];

describe("spending_limit_contracts' signer and recovery (0083)", () => {
  it("is signed by a browser wallet unless said otherwise, with no recovery decided", async () => {
    const orgId = await freshRow("signer-default-co");
    expect(await rowOf(orgId)).toEqual({ treasury_signer: "wallet", recovery_address: null, recovery_skipped_at: null });
  });

  it("takes a passkey, and nothing else", async () => {
    const orgId = await freshRow("signer-passkey-co");
    await db.query("update public.spending_limit_contracts set treasury_signer = 'passkey' where org_id = $1", [orgId]);
    expect((await rowOf(orgId)).treasury_signer).toBe("passkey");
    await expect(db.query("update public.spending_limit_contracts set treasury_signer = 'custodian' where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_treasury_signer_check/
    );
  });

  it("keeps a recovery address only as an address, and when it was skipped", async () => {
    const orgId = await freshRow("signer-recovery-co");
    await expect(db.query("update public.spending_limit_contracts set recovery_address = '0x12' where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_recovery_address_check/
    );
    await db.query("update public.spending_limit_contracts set recovery_address = $2, recovery_skipped_at = now() where org_id = $1", [orgId, RECOVERY]);
    const row = await rowOf(orgId);
    expect(row.recovery_address).toBe(RECOVERY);
    expect(row.recovery_skipped_at).not.toBeNull();
  });
});

describe("0083 replayed", () => {
  it("changes nothing already written", async () => {
    const orgId = await freshRow("signer-replay-co");
    await db.query("update public.spending_limit_contracts set treasury_signer = 'passkey', recovery_address = $2 where org_id = $1", [orgId, RECOVERY]);
    await applyMigrations(db);
    expect(await rowOf(orgId)).toMatchObject({ treasury_signer: "passkey", recovery_address: RECOVERY });
  }, 60_000);
});
