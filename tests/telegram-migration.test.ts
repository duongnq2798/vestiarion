import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendSignedForOrg, applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR,
} from "./support/pglite";

/**
 * Migration 0064 (docs/superpowers/specs/2026-10-03-telegram-bot-design.md §5, R4–R6): a member's Telegram chat,
 * connected by a one-time code. Platform tables only the service role touches; a link belongs to a membership and
 * goes with it; a chat has one active workspace; claiming a code and switching workspaces are each one statement
 * the database makes atomic.
 */

let db: PGlite;
let orgA: string;
let orgB: string;
let user: string;
let other: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");

const hashOf = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

async function member(orgId: string, userId: string, role = "owner") {
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]);
}

async function code(orgId: string, userId: string, plain: string, expires = "10 minutes") {
  await db.query(
    "insert into public.telegram_link_codes (org_id, user_id, code_hash, expires_at) values ($1, $2, $3, now() + $4::interval)",
    [orgId, userId, hashOf(plain), expires]
  );
}

interface LinkRow {
  id: string;
  org_id: string;
  user_id: string;
  chat_id: string;
  username: string | null;
  active: boolean;
  notified_seq: string;
}

const LINK_COLUMNS = "id, org_id, user_id, chat_id::text as chat_id, username, active, notified_seq::text as notified_seq";

const claim = (plain: string, chatId: number, username: string | null = "linh_ops") =>
  asServiceRole(db, async (tx) =>
    (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from public.telegram_claim_code($1, $2, $3)`, [hashOf(plain), chatId, username])).rows
  );

const activate = (chatId: number, linkId: string) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from public.telegram_activate($1, $2)`, [chatId, linkId])).rows
  );

const linksOfChat = async (chatId: number) =>
  (await db.query<LinkRow>(`select ${LINK_COLUMNS} from public.telegram_links where chat_id = $1 order by linked_at`, [chatId])).rows;

const ledgerHead = async (orgId: string) =>
  (await db.query<{ head: string }>("select coalesce(max(seq), 0)::text as head from public.ledger_entries where org_id = $1", [orgId])).rows[0].head;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  user = await createUser(db, "linh@example.com");
  other = await createUser(db, "not-a-member@example.com");
  orgA = await createOrg(db, "telegram-a");
  orgB = await createOrg(db, "telegram-b");
  await member(orgA, user);
  await member(orgB, user, "viewer");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("telegram_claim_code (0064, R4)", () => {
  it("links the chat with an unused, unexpired code, starting at the workspace's own ledger head", async () => {
    const input = { actor: "system" as const, domain: "system" as const, action: "seed", summary: "seed", detail: {} };
    await appendSignedForOrg(db, orgA, input, privateKey);
    await appendSignedForOrg(db, orgA, input, privateKey);
    // A later entry in another workspace has a higher seq, and must not become this link's cursor.
    await appendSignedForOrg(db, orgB, input, privateKey);
    await code(orgA, user, "code-a-1");

    const rows = await claim("code-a-1", 1001);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: orgA, user_id: user, chat_id: "1001", username: "linh_ops", active: true });
    expect(rows[0].notified_seq).toBe(await ledgerHead(orgA));
    expect(Number(rows[0].notified_seq)).toBeLessThan(Number(await ledgerHead(orgB)));
  });

  it("links nothing the second time the same code is used", async () => {
    await code(orgA, user, "code-a-twice");
    expect(await claim("code-a-twice", 1001)).toHaveLength(1);
    expect(await claim("code-a-twice", 9999)).toEqual([]);
    expect(await linksOfChat(9999)).toEqual([]);
  });

  it("links nothing with an expired code", async () => {
    await code(orgA, user, "code-a-expired", "-1 minute");
    expect(await claim("code-a-expired", 7777)).toEqual([]);
    expect(await linksOfChat(7777)).toEqual([]);
  });

  it("links nothing with a code nobody made", async () => {
    expect(await claim("never-made", 7777)).toEqual([]);
  });

  it("makes a second workspace connected from the same chat the chat's only active link", async () => {
    await code(orgA, user, "code-a-2");
    await code(orgB, user, "code-b-2");
    await claim("code-a-2", 2002);
    await claim("code-b-2", 2002);

    const links = await linksOfChat(2002);
    expect(links.map((link) => [link.org_id, link.active])).toEqual([
      [orgA, false],
      [orgB, true],
    ]);
  });

  it("moves a membership connected again from another chat, so it has one chat", async () => {
    await code(orgA, user, "code-a-3");
    await claim("code-a-3", 3003);
    await code(orgA, user, "code-a-4");
    await claim("code-a-4", 3004, null);

    const rows = (await db.query<{ chat_id: string; username: string | null }>(
      "select chat_id::text as chat_id, username from public.telegram_links where org_id = $1 and user_id = $2",
      [orgA, user]
    )).rows;
    expect(rows).toEqual([{ chat_id: "3004", username: null }]);
  });
});

describe("telegram_activate (0064, R5)", () => {
  it("switches the chat's active link, and ignores a link of another chat", async () => {
    await code(orgA, user, "code-a-5");
    await code(orgB, user, "code-b-5");
    const [a] = await claim("code-a-5", 5005);
    const [b] = await claim("code-b-5", 5005);
    expect(b.active).toBe(true);

    expect((await activate(5005, a.id)).map((link) => link.org_id)).toEqual([orgA]);
    expect((await linksOfChat(5005)).filter((link) => link.active).map((link) => link.org_id)).toEqual([orgA]);

    // Another chat cannot activate this chat's link.
    expect(await activate(6006, b.id)).toEqual([]);
    expect((await linksOfChat(5005)).filter((link) => link.active).map((link) => link.org_id)).toEqual([orgA]);
  });
});

describe("the telegram tables (0064)", () => {
  it("refuse a link or a code for someone who is not a member", async () => {
    await expect(
      db.query("insert into public.telegram_links (org_id, user_id, chat_id) values ($1, $2, 8008)", [orgA, other])
    ).rejects.toThrow(/telegram_links_membership_fkey/);
    await expect(code(orgA, other, "code-other")).rejects.toThrow(/telegram_link_codes_membership_fkey/);
  });

  it("refuse a code hash that is not 64 lower-case hex characters", async () => {
    await expect(
      db.query("insert into public.telegram_link_codes (org_id, user_id, code_hash, expires_at) values ($1, $2, 'ABC', now())", [orgA, user])
    ).rejects.toThrow(/telegram_link_codes_code_hash_check/);
  });

  it("refuse two active links on one chat", async () => {
    const third = await createUser(db, "third@example.com");
    await member(orgA, third, "approver");
    await member(orgB, third, "approver");
    await db.query("insert into public.telegram_links (org_id, user_id, chat_id) values ($1, $2, 9009)", [orgA, third]);
    await expect(
      db.query("insert into public.telegram_links (org_id, user_id, chat_id) values ($1, $2, 9009)", [orgB, third])
    ).rejects.toThrow(/telegram_links_active_chat/);
  });

  it("let a membership's codes, link and drafts go with it", async () => {
    const leaving = await createUser(db, "leaving@example.com");
    await member(orgA, leaving, "admin");
    await code(orgA, leaving, "code-leaving");
    await code(orgA, leaving, "code-leaving-used");
    const [link] = await claim("code-leaving-used", 4004);
    await db.query(
      "insert into public.telegram_drafts (link_id, draft, document, expires_at) values ($1, '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour')",
      [link.id]
    );

    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [orgA, leaving]);

    const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(sql, params)).rows[0].n;
    expect(await count("select count(*)::int as n from public.telegram_link_codes where user_id = $1", [leaving])).toBe(0);
    expect(await count("select count(*)::int as n from public.telegram_links where user_id = $1", [leaving])).toBe(0);
    expect(await count("select count(*)::int as n from public.telegram_drafts where link_id = $1", [link.id])).toBe(0);
  });

  it.each(["telegram_link_codes", "telegram_links", "telegram_drafts"])("let neither the browser roles nor a tenant read %s", async (table) => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
  });

  it("let only the service role claim a code or switch a chat", async () => {
    await expect(
      asRole(db, "authenticated", (tx) => tx.query("select * from public.telegram_claim_code($1, 1, null)", [hashOf("x")]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(db, orgA, (tx) => tx.query("select * from public.telegram_activate(1, gen_random_uuid())"))
    ).rejects.toThrow(/permission denied/);
  });

  it("runs again without error or loss, as db:migrate runs every file", async () => {
    const rows = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.telegram_links")).rows[0].n;
    const before = await rows();
    expect(before).toBeGreaterThan(0);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0064_telegram.sql"), "utf8"));
    expect(await rows()).toBe(before);
  });
});
