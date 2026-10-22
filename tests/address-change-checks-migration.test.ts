import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, seedOrgRows } from "./support/pglite";

/**
 * Migration 0137 (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC1-AC4): one open check per payee, read
 * by its workspace alone; the payee's preview and answer by token, once; "not me" freezing the payee and withdrawing its
 * confirmation only while the address in question is still on file; no confirmation of a frozen payee; and unfreezing.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  await applyMigrations(db, (file) => file.startsWith("0137_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");
const OLD = "0x1111111111111111111111111111111111111111";
const NEW = "0x7a2dC41e9b03F6a85d1c27e4b98f0a3c61d5e10d";

/** A payee whose address changed from OLD to NEW and was confirmed. */
async function changedPayee(tag: string): Promise<{ orgId: string; counterpartyId: string }> {
  const orgId = await createOrg(db, tag);
  const { counterpartyId } = await seedOrgRows(db, orgId, tag);
  await db.query(
    `update public.counterparties set address = $2, notice_email = 'ap@payee.example', address_changed_at = now() - interval '1 hour',
       address_confirmed_at = now() - interval '30 minutes' where id = $1`,
    [counterpartyId, NEW]
  );
  // seedOrgRows asks once about its own fixture; these tests ask for themselves.
  await db.query("delete from public.address_change_checks where counterparty_id = $1", [counterpartyId]);
  return { orgId, counterpartyId };
}

const ask = (orgId: string, counterpartyId: string, token: string) =>
  asServiceRole(db, (tx) =>
    tx.query<{ id: string; status: string }>(
      "select * from public.create_address_change_check($1, $2, $3, $4, 'member', null, null, 'ap@payee.example', $5, now() + interval '7 days')",
      [orgId, counterpartyId, OLD, NEW, token]
    )
  );

const answer = (token: string, notMe: boolean) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; counterparty_id: string | null }>("select * from public.answer_address_change_check($1, $2)", [token, notMe]));

const payee = async (id: string) =>
  (
    await db.query<{ frozen_at: string | null; frozen_check_id: string | null; address_confirmed_at: string | null }>(
      "select frozen_at, frozen_check_id, address_confirmed_at from public.counterparties where id = $1",
      [id]
    )
  ).rows[0];

describe("asking (AC1)", () => {
  it("keeps one open check per payee: a newer change replaces the older", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-replace");
    const older = hash();
    await ask(orgId, counterpartyId, older);
    await ask(orgId, counterpartyId, hash());
    const rows = (await db.query<{ status: string }>("select status from public.address_change_checks where counterparty_id = $1 order by created_at", [counterpartyId])).rows;
    expect(rows.map((row) => row.status)).toEqual(["replaced", "open"]);
    // The older link no longer answers.
    expect((await answer(older, true)).rows[0].outcome).toBe("not_valid");
  });

  it("makes nothing when asked late, after the address changed again", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-late");
    const current = hash();
    await ask(orgId, counterpartyId, current);
    await db.query("update public.counterparties set address = $2 where id = $1", [counterpartyId, OLD]);
    const late = (await ask(orgId, counterpartyId, hash())).rows[0];
    expect(late.id).toBeNull();
    const rows = (await db.query<{ token_hash: string; status: string }>("select token_hash, status from public.address_change_checks where counterparty_id = $1", [counterpartyId])).rows;
    expect(rows).toEqual([{ token_hash: current, status: "open" }]);
  });

  it("refuses a counterparty of another workspace", async () => {
    const { counterpartyId } = await changedPayee("acc-mine");
    const other = await createOrg(db, "acc-other");
    await expect(ask(other, counterpartyId, hash())).rejects.toThrow(/check_not_possible/);
  });

  it("marks a check sent once its email went out, and only once", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-sent");
    const check = (await ask(orgId, counterpartyId, hash())).rows[0];
    const mark = () => asServiceRole(db, (tx) => tx.query<{ mark_address_change_check_sent: boolean }>("select public.mark_address_change_check_sent($1)", [check.id]));
    expect((await mark()).rows[0].mark_address_change_check_sent).toBe(true);
    expect((await mark()).rows[0].mark_address_change_check_sent).toBe(false);
    expect((await db.query<{ sent_at: string | null }>("select sent_at from public.address_change_checks where id = $1", [check.id])).rows[0].sent_at).not.toBeNull();
  });
});

describe("the payee's page (AC3)", () => {
  it("previews an open check by its token, and nothing for an unknown one", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-preview");
    const token = hash();
    await ask(orgId, counterpartyId, token);
    const seen = (await asServiceRole(db, (tx) => tx.query<{ counterparty_name: string; from_address: string; to_address: string; via: string }>("select * from public.address_change_check_preview($1)", [token]))).rows;
    expect(seen).toEqual([expect.objectContaining({ counterparty_name: "cp-acc-preview", from_address: OLD, to_address: NEW, via: "member" })]);
    expect((await asServiceRole(db, (tx) => tx.query("select * from public.address_change_check_preview($1)", [hash()]))).rows).toEqual([]);
  });

  it("takes yes once, and freezes nothing", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-yes");
    const token = hash();
    await ask(orgId, counterpartyId, token);
    expect((await answer(token, false)).rows[0].outcome).toBe("confirmed");
    expect((await answer(token, true)).rows[0].outcome).toBe("not_valid");
    expect(await payee(counterpartyId)).toMatchObject({ frozen_at: null });
    expect((await payee(counterpartyId)).address_confirmed_at).not.toBeNull();
  });

  it("freezes the payee on not me, and withdraws its confirmation, while the address is on file", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-no");
    const token = hash();
    const check = (await ask(orgId, counterpartyId, token)).rows[0];
    expect((await answer(token, true)).rows[0]).toMatchObject({ outcome: "frozen", counterparty_id: counterpartyId });
    const after = await payee(counterpartyId);
    expect(after.frozen_at).not.toBeNull();
    expect(after.frozen_check_id).toBe(check.id);
    expect(after.address_confirmed_at).toBeNull();
  });

  it("records not me without freezing when the address has changed again since", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-moved");
    const token = hash();
    await ask(orgId, counterpartyId, token);
    await db.query("update public.counterparties set address = $2 where id = $1", [counterpartyId, OLD]);
    expect((await answer(token, true)).rows[0].outcome).toBe("disputed");
    expect(await payee(counterpartyId)).toMatchObject({ frozen_at: null });
  });

  it("refuses an expired link", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-expired");
    const token = hash();
    await ask(orgId, counterpartyId, token);
    await db.query("update public.address_change_checks set created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' where token_hash = $1", [token]);
    expect((await answer(token, true)).rows[0].outcome).toBe("not_valid");
  });
});

describe("a frozen payee (AC3, AC4)", () => {
  it("cannot have its address confirmed by anyone, until it is unfrozen", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-guard");
    const token = hash();
    await ask(orgId, counterpartyId, token);
    await answer(token, true);
    await expect(db.query("update public.counterparties set address_confirmed_at = now() where id = $1", [counterpartyId])).rejects.toThrow(/counterparty_frozen/);
    // Other edits still go through: the address may be changed back.
    await db.query("update public.counterparties set address = $2, address_changed_at = now() where id = $1", [counterpartyId, OLD]);

    const unfreeze = () => asServiceRole(db, (tx) => tx.query<{ frozen_at: string; frozen_check_id: string }>("select * from public.unfreeze_counterparty($1, $2)", [orgId, counterpartyId]));
    const cleared = (await unfreeze()).rows;
    expect(cleared).toHaveLength(1);
    expect(cleared[0].frozen_check_id).not.toBeNull();
    expect((await unfreeze()).rows).toEqual([]);
    await db.query("update public.counterparties set address_confirmed_at = now() + interval '1 second' where id = $1", [counterpartyId]);
    expect((await payee(counterpartyId)).address_confirmed_at).not.toBeNull();
  });

  it("is unfrozen only in its own workspace", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-own");
    const token = hash();
    await ask(orgId, counterpartyId, token);
    await answer(token, true);
    const other = await createOrg(db, "acc-own-other");
    expect((await asServiceRole(db, (tx) => tx.query("select * from public.unfreeze_counterparty($1, $2)", [other, counterpartyId]))).rows).toEqual([]);
    expect((await payee(counterpartyId)).frozen_at).not.toBeNull();
  });
});

describe("putting a freeze back (AC4)", () => {
  it("restores what an unfreeze cleared, and withdraws any confirmation since", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-restore");
    const token = hash();
    await ask(orgId, counterpartyId, token);
    await answer(token, true);
    const [cleared] = (await asServiceRole(db, (tx) => tx.query<{ frozen_at: string; frozen_check_id: string }>("select * from public.unfreeze_counterparty($1, $2)", [orgId, counterpartyId]))).rows;
    await db.query("update public.counterparties set address_confirmed_at = now() + interval '1 second' where id = $1", [counterpartyId]);
    const restored = await asServiceRole(db, (tx) =>
      tx.query<{ restore_counterparty_freeze: boolean }>("select public.restore_counterparty_freeze($1, $2, $3, $4)", [orgId, counterpartyId, cleared.frozen_at, cleared.frozen_check_id])
    );
    expect(restored.rows[0].restore_counterparty_freeze).toBe(true);
    expect(await payee(counterpartyId)).toMatchObject({ frozen_check_id: cleared.frozen_check_id, address_confirmed_at: null });
  });
});

describe("who reads and writes (RLS)", () => {
  it("lets a workspace read its own checks, write none, and call no function", async () => {
    const mine = await changedPayee("acc-rls");
    const theirs = await changedPayee("acc-rls-other");
    await ask(mine.orgId, mine.counterpartyId, hash());
    await ask(theirs.orgId, theirs.counterpartyId, hash());
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.address_change_checks")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([mine.orgId]);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("update public.address_change_checks set status = 'confirmed'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select * from public.address_change_check_preview($1)", [hash()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select public.unfreeze_counterparty($1, $2)", [mine.orgId, mine.counterpartyId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.answer_address_change_check($1, true)", [hash()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select * from public.answer_address_change_check($1, true)", [hash()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select public.mark_address_change_check_sent(gen_random_uuid())"))).rejects.toThrow(/permission denied/);
  });

  it("lets the tenant role neither set nor clear a freeze, while its other edits go through", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-tenant-freeze");
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.counterparties set frozen_at = now() where id = $1", [counterpartyId]))).rejects.toThrow(/counterparty_freeze_locked/);
    const token = hash();
    await ask(orgId, counterpartyId, token);
    await answer(token, true);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.counterparties set frozen_at = null, frozen_check_id = null where id = $1", [counterpartyId]))).rejects.toThrow(/counterparty_freeze_locked/);
    await asTenant(db, orgId, (tx) => tx.query("update public.counterparties set name = 'Renamed' where id = $1", [counterpartyId]));
    expect((await payee(counterpartyId)).frozen_at).not.toBeNull();
  });
});

describe("re-running (migrate.ts runs every file each time)", () => {
  it("applies twice without error, and keeps what it holds", async () => {
    const { orgId, counterpartyId } = await changedPayee("acc-rerun");
    await ask(orgId, counterpartyId, hash());
    await applyMigrations(db, (file) => file.startsWith("0137_"));
    expect((await db.query("select 1 from public.address_change_checks where counterparty_id = $1 and status = 'open'", [counterpartyId])).rows).toHaveLength(1);
  });
});
