import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0067 (docs/superpowers/specs/2026-10-03-slack-design.md §5, S3–S5, S8): a workspace's Slack install, its
 * members' links to their Slack accounts, and the one-time codes that make a link. Platform tables only the service
 * role touches; a link belongs to a membership and to the install, and goes with either; a code links once, before it
 * expires, and only to the workspace that installed the code's Slack team.
 */

let db: PGlite;
let orgA: string;
let orgB: string;
let user: string;
let other: string;

const hashOf = (code: string) => crypto.createHash("sha256").update(code).digest("hex");
const ENVELOPE = JSON.stringify({ k: "t1", iv: "aXY=", tag: "dGFn", ct: "Y3Q=" });

async function member(orgId: string, userId: string, role = "owner") {
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]);
}

async function install(orgId: string, teamId: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { app_id: "A0SLACKAPP", channel_id: "C0FINANCE", bot_token_enc: ENVELOPE, webhook_url_enc: ENVELOPE, ...fields };
  await db.query(
    `insert into public.slack_installs (org_id, team_id, app_id, channel_id, bot_token_enc, webhook_url_enc, decisions_limit_usdc)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [orgId, teamId, row.app_id, row.channel_id, row.bot_token_enc, row.webhook_url_enc, row.decisions_limit_usdc ?? null]
  );
}

async function request(teamId: string, slackUserId: string, plain: string, expires = "10 minutes") {
  await db.query(
    "insert into public.slack_link_requests (team_id, slack_user_id, slack_user_name, code_hash, expires_at) values ($1, $2, 'linh', $3, now() + $4::interval)",
    [teamId, slackUserId, hashOf(plain), expires]
  );
}

interface LinkRow {
  id: string;
  org_id: string;
  user_id: string;
  team_id: string;
  slack_user_id: string;
}

const linkMember = (plain: string, orgId: string, userId: string) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<LinkRow>("select id, org_id, user_id, team_id, slack_user_id from public.slack_link_member($1, $2, $3)", [hashOf(plain), orgId, userId])).rows
  );

const links = async (where: string, params: unknown[]) =>
  (await db.query<LinkRow>(`select id, org_id, user_id, team_id, slack_user_id from public.slack_links where ${where} order by linked_at`, params)).rows;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "linh@example.com");
  other = await createUser(db, "not-a-member@example.com");
  orgA = await createOrg(db, "slack-a");
  orgB = await createOrg(db, "slack-b");
  await member(orgA, user);
  await member(orgB, user, "approver");
  await install(orgA, "T0TEAMA");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("slack_installs (0067, S3, S8)", () => {
  it("lets one Slack team serve one workspace, and a workspace hold one install", async () => {
    await expect(install(orgB, "T0TEAMA")).rejects.toThrow(/slack_installs_team_id_key/);
    await expect(install(orgA, "T0OTHER")).rejects.toThrow(/slack_installs_org_id_key/);
  });

  it("keeps a decisions limit above zero, or none", async () => {
    await expect(install(orgB, "T0TEAMB", { decisions_limit_usdc: 0 })).rejects.toThrow(/slack_installs_decisions_limit_check/);
    await install(orgB, "T0TEAMB", { decisions_limit_usdc: 5 });
    const row = (await db.query<{ limit: string; seq: string }>(
      "select decisions_limit_usdc::text as limit, notified_seq::text as seq from public.slack_installs where org_id = $1",
      [orgB]
    )).rows[0];
    expect(row).toEqual({ limit: "5.000000", seq: "0" });
    await db.query("delete from public.slack_installs where org_id = $1", [orgB]);
  });

  it("refuses an id that is not one of Slack's", async () => {
    await expect(install(orgB, "not a team")).rejects.toThrow(/slack_installs_team_id_check/);
    await expect(install(orgB, "T0TEAMB", { channel_id: "#finance" })).rejects.toThrow(/slack_installs_channel_id_check/);
  });

  it("goes with its workspace", async () => {
    const gone = await createOrg(db, "slack-gone");
    await install(gone, "T0GONE");
    await db.query("delete from public.orgs where id = $1", [gone]);
    expect((await db.query("select 1 from public.slack_installs where team_id = 'T0GONE'")).rows).toEqual([]);
  });
});

describe("slack_link_member (0067, S4)", () => {
  it("links a member with an unused, unexpired code for the workspace's own Slack team", async () => {
    await request("T0TEAMA", "U0LINH", "code-1");
    const rows = await linkMember("code-1", orgA, user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: orgA, user_id: user, team_id: "T0TEAMA", slack_user_id: "U0LINH" });
  });

  it("links nothing the second time a code is used, or after it expired", async () => {
    await request("T0TEAMA", "U0TWICE", "code-twice");
    expect(await linkMember("code-twice", orgA, user)).toHaveLength(1);
    expect(await linkMember("code-twice", orgA, user)).toEqual([]);
    await request("T0TEAMA", "U0LATE", "code-late", "-1 minute");
    expect(await linkMember("code-late", orgA, user)).toEqual([]);
    expect(await linkMember("never-made", orgA, user)).toEqual([]);
  });

  it("links nothing, and keeps the code, for a workspace that did not install the code's Slack team", async () => {
    await request("T0TEAMA", "U0ELSEWHERE", "code-b");
    expect(await linkMember("code-b", orgB, user)).toEqual([]);
    const used = (await db.query<{ used_at: string | null }>("select used_at from public.slack_link_requests where code_hash = $1", [hashOf("code-b")])).rows[0];
    expect(used.used_at).toBeNull();
  });

  it("links nothing for someone who is not a member", async () => {
    await request("T0TEAMA", "U0STRANGER", "code-stranger");
    expect(await linkMember("code-stranger", orgA, other)).toEqual([]);
  });

  it("replaces the member's earlier Slack account, and that Slack account's earlier member", async () => {
    const second = await createUser(db, "second@example.com");
    await member(orgA, second, "approver");
    await request("T0TEAMA", "U0FIRST", "code-first");
    await linkMember("code-first", orgA, second);
    await request("T0TEAMA", "U0SECOND", "code-second");
    await linkMember("code-second", orgA, second);
    expect((await links("user_id = $1", [second])).map((link) => link.slack_user_id)).toEqual(["U0SECOND"]);

    await request("T0TEAMA", "U0SECOND", "code-moved");
    await linkMember("code-moved", orgA, user);
    expect(await links("user_id = $1", [second])).toEqual([]);
    expect((await links("slack_user_id = 'U0SECOND'", [])).map((link) => link.user_id)).toEqual([user]);
  });
});

describe("the slack tables (0067)", () => {
  it("refuse a link for someone who is not a member, or to a team the workspace did not install", async () => {
    await expect(
      db.query("insert into public.slack_links (org_id, user_id, team_id, slack_user_id) values ($1, $2, 'T0TEAMA', 'U0X')", [orgA, other])
    ).rejects.toThrow(/slack_links_membership_fkey/);
    const unlinked = await createUser(db, "unlinked@example.com");
    await member(orgA, unlinked, "viewer");
    await expect(
      db.query("insert into public.slack_links (org_id, user_id, team_id, slack_user_id) values ($1, $2, 'T0NOPE', 'U0Y')", [orgA, unlinked])
    ).rejects.toThrow(/slack_links_install_fkey/);
  });

  it("let a link go with its membership, and every link with the install", async () => {
    const leaving = await createUser(db, "leaving@example.com");
    await member(orgA, leaving, "admin");
    await request("T0TEAMA", "U0LEAVING", "code-leaving");
    await linkMember("code-leaving", orgA, leaving);
    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [orgA, leaving]);
    expect(await links("user_id = $1", [leaving])).toEqual([]);

    const temp = await createOrg(db, "slack-temp");
    await member(temp, user);
    await install(temp, "T0TEMP");
    await request("T0TEMP", "U0TEMP", "code-temp");
    expect(await linkMember("code-temp", temp, user)).toHaveLength(1);
    await db.query("delete from public.slack_installs where org_id = $1", [temp]);
    expect(await links("org_id = $1", [temp])).toEqual([]);
  });

  it("refuse a code hash that is not 64 lower-case hex characters", async () => {
    await expect(
      db.query("insert into public.slack_link_requests (team_id, slack_user_id, code_hash, expires_at) values ('T0TEAMA', 'U0Z', 'ABC', now())")
    ).rejects.toThrow(/slack_link_requests_code_hash_check/);
  });

  it.each(["slack_installs", "slack_links", "slack_link_requests"])("let neither the browser roles nor a tenant read %s", async (table) => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
  });

  it("let only the service role link a member", async () => {
    await expect(
      asRole(db, "authenticated", (tx) => tx.query("select * from public.slack_link_member($1, $2, $3)", [hashOf("x"), orgA, user]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(db, orgA, (tx) => tx.query("select * from public.slack_link_member($1, $2, $3)", [hashOf("x"), orgA, user]))
    ).rejects.toThrow(/permission denied/);
  });

  it("runs again without error or loss, as db:migrate runs every file", async () => {
    const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.slack_links")).rows[0].n;
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0067_slack.sql"), "utf8"));
    expect(await count()).toBe(before);
  });
});
