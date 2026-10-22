import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0139 (docs/superpowers/specs/2026-10-22-discord-design.md DC2): a workspace's Discord channel webhook, a
 * platform table only the service role touches, as slack_installs (0067) is. One per workspace, going with it; Discord's
 * ids held to their form; the person who connected it forgotten with their account, the connection kept.
 */

let db: PGlite;
let orgA: string;
let orgB: string;
let user: string;

const ENVELOPE = JSON.stringify({ k: "t1", iv: "aXY=", tag: "dGFn", ct: "Y3Q=" });
const SNOWFLAKE = "1234567890123456789";

async function connect(orgId: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { webhook_id: SNOWFLAKE, channel_id: "3234567890123456789", guild_id: null, name: "Finance", connected_by: null, ...fields };
  await db.query(
    `insert into public.discord_webhooks (org_id, webhook_id, channel_id, guild_id, name, webhook_url_enc, connected_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [orgId, row.webhook_id, row.channel_id, row.guild_id, row.name, ENVELOPE, row.connected_by]
  );
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "owner@example.com");
  orgA = await createOrg(db, "discord-a");
  orgB = await createOrg(db, "discord-b");
  await connect(orgA, { connected_by: user });
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("discord_webhooks (0139, DC2)", () => {
  it("starts the cursor and the failures at zero, with no error", async () => {
    const row = (await db.query<{ seq: string; failures: number; last_error: string | null; connected_at: Date | null }>(
      "select notified_seq::text as seq, failures, last_error, connected_at from public.discord_webhooks where org_id = $1",
      [orgA]
    )).rows[0];
    expect(row).toMatchObject({ seq: "0", failures: 0, last_error: null });
    expect(row.connected_at).not.toBeNull();
  });

  it("holds one connection per workspace", async () => {
    await expect(connect(orgA)).rejects.toThrow(/discord_webhooks_org_id_key/);
  });

  it("refuses ids that are not Discord's snowflakes, and a name that is blank or too long", async () => {
    await expect(connect(orgB, { webhook_id: "123" })).rejects.toThrow(/discord_webhooks_webhook_id_check/);
    await expect(connect(orgB, { channel_id: "#finance" })).rejects.toThrow(/discord_webhooks_channel_id_check/);
    await expect(connect(orgB, { guild_id: "1".repeat(21) })).rejects.toThrow(/discord_webhooks_guild_id_check/);
    await expect(connect(orgB, { name: "" })).rejects.toThrow(/discord_webhooks_name_check/);
    await expect(connect(orgB, { name: "n".repeat(81) })).rejects.toThrow(/discord_webhooks_name_check/);
  });

  it("keeps at most 300 characters of an error, and no negative count of failures", async () => {
    await connect(orgB);
    await expect(db.query("update public.discord_webhooks set last_error = $2 where org_id = $1", [orgB, "x".repeat(301)])).rejects.toThrow(
      /discord_webhooks_last_error_check/
    );
    await expect(db.query("update public.discord_webhooks set failures = -1 where org_id = $1", [orgB])).rejects.toThrow(/discord_webhooks_failures_check/);
    await db.query("update public.discord_webhooks set last_error = $2, failures = 3 where org_id = $1", [orgB, "x".repeat(300)]);
    await db.query("delete from public.discord_webhooks where org_id = $1", [orgB]);
  });

  it("goes with its workspace", async () => {
    const gone = await createOrg(db, "discord-gone");
    await connect(gone);
    await db.query("delete from public.orgs where id = $1", [gone]);
    expect((await db.query("select 1 from public.discord_webhooks where org_id = $1", [gone])).rows).toEqual([]);
  });

  it("forgets who connected it when their account goes, and keeps the connection", async () => {
    const leaving = await createUser(db, "leaving@example.com");
    const kept = await createOrg(db, "discord-kept");
    await connect(kept, { connected_by: leaving });
    await db.query("delete from auth.users where id = $1", [leaving]);
    const row = (await db.query<{ connected_by: string | null }>("select connected_by from public.discord_webhooks where org_id = $1", [kept])).rows[0];
    expect(row).toEqual({ connected_by: null });
  });

  it("has RLS on and no policy", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_catalog.pg_class where oid = 'public.discord_webhooks'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    expect((await db.query("select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'discord_webhooks'")).rows).toHaveLength(0);
  });

  it("lets neither the browser roles nor a tenant read or write it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.discord_webhooks"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select * from public.discord_webhooks"))).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(db, orgA, (tx) => tx.query("update public.discord_webhooks set notified_seq = 1 where org_id = $1", [orgA]))
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the service role read it", async () => {
    const rows = await asServiceRole(db, async (tx) => (await tx.query("select org_id from public.discord_webhooks where org_id = $1", [orgA])).rows);
    expect(rows).toHaveLength(1);
  });

  it("runs again without error or loss, as db:migrate runs every file", async () => {
    const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.discord_webhooks")).rows[0].n;
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0139_discord.sql"), "utf8"));
    expect(await count()).toBe(before);
    await expect(asTenant(db, orgA, (tx) => tx.query("select * from public.discord_webhooks"))).rejects.toThrow(/permission denied/);
  });
});
