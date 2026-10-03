import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0070 (Slack design S15): an invoice someone chose in Slack, read and held as a draft for its Add, as the
 * Telegram bot's drafts are; and the permissions each install granted, so Settings can say when Slack must be
 * connected again to read a file. A draft belongs to the Slack link it was read for, and goes with it.
 */

let db: PGlite;
let org: string;
let user: string;

const hashOf = (code: string) => crypto.createHash("sha256").update(code).digest("hex");
const ENVELOPE = JSON.stringify({ k: "t1", iv: "aXY=", tag: "dGFn", ct: "Y3Q=" });
const DRAFT = JSON.stringify({ counterpartyId: "c", amount: "0.75", currency: "USDC", memo: "", poReference: "", dueDate: "2026-10-10" });
const DOCUMENT = JSON.stringify({ kind: "pdf", sha256: "a".repeat(64), reader: "heuristic" });

async function linkFor(orgId: string, userId: string, teamId: string, slackUserId: string): Promise<string> {
  await db.query(
    "insert into public.slack_link_requests (team_id, slack_user_id, code_hash, expires_at) values ($1, $2, $3, now() + interval '10 minutes')",
    [teamId, slackUserId, hashOf(`${teamId}-${slackUserId}`)]
  );
  const rows = await asServiceRole(db, async (tx) =>
    (await tx.query<{ id: string }>("select id from public.slack_link_member($1, $2, $3)", [hashOf(`${teamId}-${slackUserId}`), orgId, userId])).rows
  );
  return rows[0].id;
}

async function draft(linkId: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "insert into public.slack_drafts (link_id, draft, document, expires_at) values ($1, $2::jsonb, $3::jsonb, now() + interval '1 hour') returning id",
    [linkId, DRAFT, DOCUMENT]
  );
  return rows.rows[0].id;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "linh@example.com");
  org = await createOrg(db, "slack-drafts");
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [org, user]);
  await db.query(
    `insert into public.slack_installs (org_id, team_id, app_id, channel_id, bot_token_enc, webhook_url_enc)
     values ($1, 'T0DRAFTS', 'A0SLACKAPP', 'C0FINANCE', $2::jsonb, $2::jsonb)`,
    [org, ENVELOPE]
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("slack_installs.scopes (0070, S15)", () => {
  it("starts empty for an install made before it, and keeps what an install granted", async () => {
    const before = await db.query<{ scopes: string[] }>("select scopes from public.slack_installs where org_id = $1", [org]);
    expect(before.rows[0].scopes).toEqual([]);
    await db.query("update public.slack_installs set scopes = $2 where org_id = $1", [org, ["commands", "incoming-webhook", "files:read"]]);
    const after = await db.query<{ scopes: string[] }>("select scopes from public.slack_installs where org_id = $1", [org]);
    expect(after.rows[0].scopes).toEqual(["commands", "incoming-webhook", "files:read"]);
  });
});

describe("slack_drafts (0070, S15)", () => {
  it("holds a draft for the Slack link it was read for, and refuses one for no link", async () => {
    const link = await linkFor(org, user, "T0DRAFTS", "U0LINH");
    expect(await draft(link)).toMatch(/^[0-9a-f-]{36}$/);
    await expect(draft("0b6c1c9e-4a4f-4a7e-9b1e-000000000000")).rejects.toThrow(/slack_drafts_link_id_fkey/);
  });

  it("lets a draft go with its link", async () => {
    const other = await createUser(db, "admin@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [org, other]);
    const link = await linkFor(org, other, "T0DRAFTS", "U0ADMIN");
    const id = await draft(link);
    await db.query("delete from public.slack_links where id = $1", [link]);
    expect((await db.query("select id from public.slack_drafts where id = $1", [id])).rows).toEqual([]);
  });

  it("lets neither the browser roles nor a tenant read it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.slack_drafts"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, org, (tx) => tx.query("select * from public.slack_drafts"))).rejects.toThrow(/permission denied/);
  });

  it("runs again without error or loss, as db:migrate runs every file", async () => {
    const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.slack_drafts")).rows[0].n;
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0070_slack_drafts.sql"), "utf8"));
    expect(await count()).toBe(before);
    const scopes = await db.query<{ scopes: string[] }>("select scopes from public.slack_installs where org_id = $1", [org]);
    expect(scopes.rows[0].scopes).toContain("files:read");
  });
});
