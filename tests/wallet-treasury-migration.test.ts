import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asServiceRole, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0082 (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md W1, W8, W9, W13, W16): a third wallet
 * host, `external`, for a workspace paying from its owner's own wallet; its contract row naming that wallet and the
 * owner's own approval; a block cursor for money in; and a sandbox whose wallet approved its contract kept from the
 * automatic cleanup.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const WALLET = "0x5aF3107A4000000000000000000000000000b0b0";
const CONTRACT = "0x5aF3107A4000000000000000000000000000e5c0";
const AGENT = "0x5aF3107A4000000000000000000000000000a9e7";
const TX = `0x${"ab".repeat(32)}`;

const hostOf = async (orgId: string) => (await db.query<{ wallet_host: string | null }>("select wallet_host from public.orgs where id = $1", [orgId])).rows[0].wallet_host;

describe("orgs.wallet_host (0082)", () => {
  it("accepts external beside own and hosted, and nothing else", async () => {
    const orgId = await createOrg(db, "external-host-co");
    await db.query("update public.orgs set wallet_host = 'external' where id = $1", [orgId]);
    expect(await hostOf(orgId)).toBe("external");
    for (const host of ["own", "hosted"]) {
      await db.query("update public.orgs set wallet_host = $2 where id = $1", [orgId, host]);
      expect(await hostOf(orgId)).toBe(host);
    }
    await expect(db.query("update public.orgs set wallet_host = 'custodial' where id = $1", [orgId])).rejects.toThrow(/orgs_wallet_host_check/);
  });
});

describe("spending_limit_contracts for a wallet treasury (0082)", () => {
  it("names the owner's wallet for an external treasury, and a circle row stays as it was", async () => {
    const orgId = await createOrg(db, "external-row-co");
    await db.query("delete from public.spending_limit_contracts where org_id = $1", [orgId]);
    const fresh = (await db.query<{ treasury_kind: string }>("insert into public.spending_limit_contracts (org_id) values ($1) returning treasury_kind", [orgId])).rows[0];
    expect(fresh.treasury_kind).toBe("circle");
    await expect(db.query("update public.spending_limit_contracts set treasury_kind = 'external' where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_treasury_address_check/
    );
    await expect(db.query("update public.spending_limit_contracts set treasury_kind = 'custodial' where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_treasury_kind_check/
    );
    await expect(db.query("update public.spending_limit_contracts set treasury_address = '0x12' where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_treasury_address_format/
    );
    await db.query("update public.spending_limit_contracts set treasury_kind = 'external', treasury_address = $2 where org_id = $1", [orgId, WALLET]);
    await expect(db.query("update public.spending_limit_contracts set approve_tx_hash = '0x12' where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_approve_tx_hash_check/
    );
  });

  it("is enforced with the owner's approval transaction in place of a Circle one, and a circle row still needs Circle's", async () => {
    const external = await createOrg(db, "external-enforced-co");
    await db.query("delete from public.spending_limit_contracts where org_id = $1", [external]);
    await db.query(
      "insert into public.spending_limit_contracts (org_id, treasury_kind, treasury_address, address, agent_address) values ($1, 'external', $2, $3, $4)",
      [external, WALLET, CONTRACT, AGENT]
    );
    await expect(db.query("update public.spending_limit_contracts set enforced = true where org_id = $1", [external])).rejects.toThrow(
      /spending_limit_contracts_enforced_check/
    );
    await db.query("update public.spending_limit_contracts set approve_tx_hash = $2, enforced = true where org_id = $1", [external, TX]);

    const circle = await createOrg(db, "circle-enforced-co");
    await db.query("delete from public.spending_limit_contracts where org_id = $1", [circle]);
    await db.query("insert into public.spending_limit_contracts (org_id, address, agent_address) values ($1, $2, $3)", [circle, CONTRACT, AGENT]);
    await expect(db.query("update public.spending_limit_contracts set enforced = true where org_id = $1", [circle])).rejects.toThrow(
      /spending_limit_contracts_enforced_check/
    );
    await db.query("update public.spending_limit_contracts set approve_tx_id = 'tx-approve', enforced = true where org_id = $1", [circle]);
  });
});

describe("accounts.inbound_from_block (0082)", () => {
  it("is null until set, and holds a block number", async () => {
    const orgId = await createOrg(db, "inbound-co");
    const inserted = (
      await db.query<{ inbound_from_block: string | null }>(
        "insert into public.accounts (org_id, name, kind, chain, token, balance) values ($1, 'Operating', 'operating', 'ARC', 'USDC', 0) returning inbound_from_block",
        [orgId]
      )
    ).rows[0];
    expect(inserted.inbound_from_block).toBeNull();
    await db.query("update public.accounts set inbound_from_block = 41250000 where org_id = $1", [orgId]);
  });
});

describe("delete_sandbox_org (0082)", () => {
  const cutoff = () => new Date().toISOString();
  const makeIdle = (orgId: string) => db.query("update public.orgs set last_active_at = now() - interval '400 days' where id = $1", [orgId]);
  const purge = (orgId: string) =>
    asServiceRole(db, async (tx) => (await tx.query<{ deleted: boolean }>("select public.delete_sandbox_org($1, $2::timestamptz) as deleted", [orgId, cutoff()])).rows[0].deleted);

  it("never deletes a sandbox whose owner's wallet approved its contract", async () => {
    const orgId = await createOrg(db, "approved-wallet-co");
    await db.query("update public.orgs set wallet_host = 'external' where id = $1", [orgId]);
    await db.query("delete from public.spending_limit_contracts where org_id = $1", [orgId]);
    await db.query(
      "insert into public.spending_limit_contracts (org_id, treasury_kind, treasury_address, address, agent_address, approve_tx_hash) values ($1, 'external', $2, $3, $4, $5)",
      [orgId, WALLET, CONTRACT, AGENT, TX]
    );
    await makeIdle(orgId);
    await expect(purge(orgId)).rejects.toThrow(/has_wallet_approval/);
  });

  it("still deletes an inactive sandbox whose wallet approved nothing, and a plain one", async () => {
    const chosen = await createOrg(db, "chosen-wallet-co");
    await db.query("update public.orgs set wallet_host = 'external' where id = $1", [chosen]);
    await makeIdle(chosen);
    expect(await purge(chosen)).toBe(true);

    const plain = await createOrg(db, "plain-sandbox-co");
    await makeIdle(plain);
    expect(await purge(plain)).toBe(true);
  });
});

describe("0082 replayed", () => {
  it("runs again without error, keeping its rows and its rules", async () => {
    const orgId = await createOrg(db, "replay-wallet-co");
    await db.query("update public.orgs set wallet_host = 'external' where id = $1", [orgId]);
    await applyMigrations(db);
    expect(await hostOf(orgId)).toBe("external");
    await expect(db.query("update public.orgs set wallet_host = 'custodial' where id = $1", [orgId])).rejects.toThrow(/orgs_wallet_host_check/);
  });
});
