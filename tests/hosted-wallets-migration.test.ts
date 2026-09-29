import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0030 (hosted wallets design H4, H5, H6).
 *
 * - `orgs.wallet_host` is `'own'`, `'hosted'` or null, nothing else.
 * - `choose_hosted_wallet(p_org_id, p_limit)` marks a workspace hosted, holding
 *   the platform to `p_limit` hosted workspaces under one advisory lock.
 * - `delete_sandbox_org` (0029, redefined) also refuses a hosted sandbox that
 *   has wallets.
 *
 * Concurrency (Review Focus 2): PGlite is a single connection, so two
 * transactions cannot truly race here. The tests instead prove the two halves
 * of the argument: the function takes the platform-wide advisory lock before
 * it counts (seen in `pg_locks` from inside the calling transaction), and two
 * sessions run one after the other at the limit — which is exactly what the
 * lock turns two concurrent calls into — let only the first through.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const ENVELOPE = { v: 1, iv: "x", tag: "y", data: "z" };

const choose = (orgId: string, limit: number | null) =>
  asServiceRole(db, (tx) => tx.query("select public.choose_hosted_wallet($1, $2)", [orgId, limit]));

const hostOf = async (orgId: string) =>
  (await db.query<{ wallet_host: string | null }>("select wallet_host from public.orgs where id = $1", [orgId])).rows[0].wallet_host;

/** Everyone starts from no hosted workspaces, so each test's limit means what it says. */
const clearHosted = () => db.query("update public.orgs set wallet_host = null where wallet_host = 'hosted'");

const giveWallet = (orgId: string, tag: string) =>
  db.query(
    "insert into public.accounts (org_id, name, kind, chain, circle_wallet_id, address) values ($1, $2, 'operating', 'ARC-TESTNET', $3, '0xabc')",
    [orgId, `acct-${tag}`, `wallet-${tag}`]
  );

const purge = (orgId: string, cutoff: string) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ deleted: boolean }>(
      "select public.delete_sandbox_org($1, $2::timestamptz) as deleted", [orgId, cutoff]
    )).rows[0].deleted);

describe("orgs.wallet_host (0030)", () => {
  it("is null for a new workspace, and accepts 'own' and 'hosted' only", async () => {
    const orgId = await createOrg(db, "column-co");
    expect(await hostOf(orgId)).toBeNull();

    await db.query("update public.orgs set wallet_host = 'own' where id = $1", [orgId]);
    expect(await hostOf(orgId)).toBe("own");
    await db.query("update public.orgs set wallet_host = 'hosted' where id = $1", [orgId]);
    expect(await hostOf(orgId)).toBe("hosted");
    await db.query("update public.orgs set wallet_host = null where id = $1", [orgId]);
    expect(await hostOf(orgId)).toBeNull();

    await expect(
      db.query("update public.orgs set wallet_host = 'platform' where id = $1", [orgId])
    ).rejects.toThrow(/check constraint/);
  });
});

describe("choose_hosted_wallet (0030)", () => {
  it("marks a workspace with no credentials and no wallets as hosted", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "fresh-co");

    await choose(orgId, 100);

    expect(await hostOf(orgId)).toBe("hosted");
  });

  it("also marks a workspace that had chosen its own account, while it has nothing connected", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "was-own-co");
    await db.query("update public.orgs set wallet_host = 'own' where id = $1", [orgId]);

    await choose(orgId, 100);

    expect(await hostOf(orgId)).toBe("hosted");
  });

  it("is a no-op for a workspace already hosted, even at the limit", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "again-co");
    await choose(orgId, 1);

    await choose(orgId, 1);

    expect(await hostOf(orgId)).toBe("hosted");
  });

  it("refuses a workspace holding a Circle API key", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "keyed-co");
    await db.query("update public.orgs set circle_api_key_enc = $2::jsonb where id = $1", [orgId, JSON.stringify(ENVELOPE)]);

    await expect(choose(orgId, 100)).rejects.toThrow(/hosted_not_allowed/);
    expect(await hostOf(orgId)).toBeNull();
  });

  it("refuses a workspace holding a Circle entity secret", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "secreted-co");
    await db.query("update public.orgs set circle_entity_secret_enc = $2::jsonb where id = $1", [orgId, JSON.stringify(ENVELOPE)]);

    await expect(choose(orgId, 100)).rejects.toThrow(/hosted_not_allowed/);
    expect(await hostOf(orgId)).toBeNull();
  });

  it("refuses a workspace any of whose accounts has a wallet", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "walleted-co");
    await giveWallet(orgId, "walleted");

    await expect(choose(orgId, 100)).rejects.toThrow(/hosted_not_allowed/);
    expect(await hostOf(orgId)).toBeNull();
  });

  it("ignores accounts without a wallet", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "bare-accounts-co");
    await db.query(
      "insert into public.accounts (org_id, name, kind, chain) values ($1, 'bare', 'operating', 'ARC-TESTNET')", [orgId]
    );

    await choose(orgId, 100);

    expect(await hostOf(orgId)).toBe("hosted");
  });

  it("refuses a hosted workspace once it has wallets (the choice is fixed, H4)", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "hosted-walleted-co");
    await choose(orgId, 100);
    await giveWallet(orgId, "hosted-walleted");

    await expect(choose(orgId, 100)).rejects.toThrow(/hosted_not_allowed/);
    expect(await hostOf(orgId)).toBe("hosted");
  });

  it("refuses an organization that does not exist", async () => {
    await expect(choose("5d0f3a2e-8c1b-4f7a-9e6d-000000000000", 100)).rejects.toThrow(/org_not_found/);
  });

  it("raises hosted_limit_reached at the limit, and marks nothing", async () => {
    await clearHosted();
    const first = await createOrg(db, "limit-first-co");
    const second = await createOrg(db, "limit-second-co");
    const third = await createOrg(db, "limit-third-co");
    await choose(first, 2);
    await choose(second, 2);

    await expect(choose(third, 2)).rejects.toThrow(/hosted_limit_reached/);
    expect(await hostOf(third)).toBeNull();
  });

  it("treats a limit of zero as no hosted workspaces, and refuses a missing or negative limit", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "no-limit-co");

    await expect(choose(orgId, 0)).rejects.toThrow(/hosted_limit_reached/);
    await expect(choose(orgId, null)).rejects.toThrow(/hosted_limit_reached/);
    await expect(choose(orgId, -1)).rejects.toThrow(/hosted_limit_reached/);
    expect(await hostOf(orgId)).toBeNull();
  });

  it("takes the platform-wide advisory lock before counting", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "locked-co");

    const held = await asServiceRole(db, async (tx) => {
      await tx.query("select public.choose_hosted_wallet($1, 100)", [orgId]);
      // A transaction-level lock is held until commit, so it is still visible here.
      return (await tx.query<{ held: boolean }>(
        `select exists (
           select 1 from pg_catalog.pg_locks
            where locktype = 'advisory' and granted
              and objid = (hashtext('vestiarion_hosted_wallets')::bigint & 4294967295)::oid
         ) as held`
      )).rows[0].held;
    });

    expect(held).toBe(true);
  });

  it("lets exactly one of two sessions through at the limit (the lock serialises them)", async () => {
    await clearHosted();
    const alpha = await createOrg(db, "race-alpha-co");
    const beta = await createOrg(db, "race-beta-co");

    const outcomes = await Promise.allSettled([choose(alpha, 1), choose(beta, 1)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/hosted_limit_reached/);
    expect((await db.query("select 1 from public.orgs where wallet_host = 'hosted'")).rows).toHaveLength(1);
  });

  it("can be executed by the service role only", async () => {
    const orgId = await createOrg(db, "grants-co");
    await expect(
      asTenant(db, orgId, (tx) => tx.query("select public.choose_hosted_wallet($1, 100)", [orgId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "authenticated", (tx) => tx.query("select public.choose_hosted_wallet($1, 100)", [orgId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "anon", (tx) => tx.query("select public.choose_hosted_wallet($1, 100)", [orgId]))
    ).rejects.toThrow(/permission denied/);
    expect(await hostOf(orgId)).toBeNull();
  });
});

describe("delete_sandbox_org (0030)", () => {
  const cutoff = () => new Date().toISOString();
  const makeIdle = (orgId: string) =>
    db.query("update public.orgs set last_active_at = now() - interval '400 days' where id = $1", [orgId]);

  it("refuses an inactive hosted sandbox that has a wallet", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "hosted-idle-co");
    await choose(orgId, 100);
    await giveWallet(orgId, "hosted-idle");
    await makeIdle(orgId);

    await expect(purge(orgId, cutoff())).rejects.toThrow(/has_hosted_wallet/);
    expect((await db.query("select 1 from public.orgs where id = $1", [orgId])).rows).toHaveLength(1);
  });

  it("still deletes an inactive hosted sandbox that never created wallets", async () => {
    await clearHosted();
    const orgId = await createOrg(db, "hosted-empty-co");
    await choose(orgId, 100);
    await makeIdle(orgId);

    expect(await purge(orgId, cutoff())).toBe(true);
    expect((await db.query("select 1 from public.orgs where id = $1", [orgId])).rows).toHaveLength(0);
  });

  it("keeps the 0029 refusal for a sandbox holding Circle credentials", async () => {
    const orgId = await createOrg(db, "still-connected-co");
    await db.query("update public.orgs set circle_api_key_enc = $2::jsonb where id = $1", [orgId, JSON.stringify(ENVELOPE)]);
    await makeIdle(orgId);

    await expect(purge(orgId, cutoff())).rejects.toThrow(/has_circle_credentials/);
  });

  it("still deletes an inactive sandbox that never connected and is not hosted", async () => {
    const orgId = await createOrg(db, "plain-idle-co");
    await makeIdle(orgId);

    expect(await purge(orgId, cutoff())).toBe(true);
  });

  it("keeps the grants unchanged: only the service role can execute it", async () => {
    const orgId = await createOrg(db, "purge-guarded-co");
    await expect(
      asTenant(db, orgId, (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "authenticated", (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "anon", (tx) => tx.query("select public.delete_sandbox_org($1, now())", [orgId]))
    ).rejects.toThrow(/permission denied/);
  });
});

describe("replay (0030)", () => {
  it("is idempotent across a replay of every migration, keeping each workspace's choice", async () => {
    await clearHosted();
    const hosted = await createOrg(db, "replay-hosted-co");
    await choose(hosted, 100);
    await giveWallet(hosted, "replay-hosted");

    await applyMigrations(db);

    expect(await hostOf(hosted)).toBe("hosted");
    await db.query("update public.orgs set last_active_at = now() - interval '400 days' where id = $1", [hosted]);
    await expect(purge(hosted, new Date().toISOString())).rejects.toThrow(/has_hosted_wallet/);
    await expect(choose(hosted, 100)).rejects.toThrow(/hosted_not_allowed/);
    await expect(
      db.query("update public.orgs set wallet_host = 'platform' where id = $1", [hosted])
    ).rejects.toThrow(/check constraint/);
    // One check constraint, not one per replay.
    const checks = await db.query(
      `select 1 from pg_catalog.pg_constraint
        where conrelid = 'public.orgs'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%wallet_host%'`
    );
    expect(checks.rows).toHaveLength(1);
  });
});
