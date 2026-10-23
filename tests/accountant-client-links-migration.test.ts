import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createUser, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0143 (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md): an accountant's client invite
 * links. A platform table only the service role touches, holding each link's SHA-256 and never the link; links made only
 * by someone who is an accountant somewhere, at most 10 open and 20 a day; and a claim that adds the accountant to the
 * client's new workspace with the accountant role and nothing else, once, after every check.
 */

let db: PGlite;
let accountant: string, client: string, stranger: string, books: string;
let practice: string;

const FILE = "0143_accountant_client_links.sql";
const hash = () => crypto.randomBytes(32).toString("hex");
const call = <T = Record<string, unknown>>(sql: string, params: unknown[]) => asServiceRole(db, async (tx) => (await tx.query<T>(sql, params)).rows);

type LinkRow = { id: string; created_by: string; email: string | null; token_hash: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null; org_id: string | null; created_at: Date };

const create = async (actor: string, email: string | null = null, tokenHash = hash()) =>
  (await call<LinkRow>("select * from public.create_client_link($1, $2, $3)", [actor, email, tokenHash]))[0];
const revoke = (actor: string, linkId: string) => call<LinkRow>("select * from public.revoke_client_link($1, $2)", [actor, linkId]);
const preview = async (tokenHash: string) =>
  (await call<{ link_id: string | null; state: string; accountant_id: string | null; accountant_email: string | null; bound_email: string | null; token_hash: string }>(
    "select * from public.client_link_preview($1)",
    [tokenHash]
  ))[0];
const claim = (tokenHash: string, userId: string, orgId: string) =>
  call<{ link_id: string; accountant_id: string }>("select * from public.claim_client_link($1, $2, $3)", [tokenHash, userId, orgId]);

/** A workspace as create_org leaves it: made by `owner`, who is its owner. */
async function ownedBy(owner: string, slug: string): Promise<string> {
  const orgId = (await db.query<{ id: string }>("insert into public.orgs (slug, name, mode, created_by) values ($1, $1, 'sandbox', $2) returning id", [slug, owner])).rows[0].id;
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, owner]);
  return orgId;
}

const roleIn = async (orgId: string, userId: string) =>
  (await db.query<{ role: string; invited_by: string | null }>("select role, invited_by from public.memberships where org_id = $1 and user_id = $2", [orgId, userId])).rows[0];

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file === FILE);
  accountant = await createUser(db, "books@practice.example");
  client = await createUser(db, "owner@client.example");
  stranger = await createUser(db, "someone@else.example");
  books = await createUser(db, "busy@practice.example");
  const owner = await createUser(db, "first-owner@example.com");
  practice = await ownedBy(owner, "first-client");
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [practice, accountant]);
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [practice, books]);
  // An approver somewhere is not an accountant.
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'approver')", [practice, stranger]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("accountant_client_links (0143)", () => {
  it("keeps only a token's SHA-256, once per link", async () => {
    const tokenHash = hash();
    await create(accountant, null, tokenHash);
    await expect(create(accountant, null, tokenHash)).rejects.toThrow(/accountant_client_links_token_hash_key/);
    await expect(create(accountant, null, "vxj_not-a-hash")).rejects.toThrow(/accountant_client_links_token_hash_check/);
    await expect(create(accountant, null, "A".repeat(64))).rejects.toThrow(/accountant_client_links_token_hash_check/);
  });

  it("holds an email lowercased and at most 254 characters, or none", async () => {
    const insert = (email: string) =>
      db.query("insert into public.accountant_client_links (created_by, email, token_hash, expires_at) values ($1, $2, $3, now() + interval '7 days')", [accountant, email, hash()]);
    await expect(insert("Owner@Client.example")).rejects.toThrow(/accountant_client_links_email_check/);
    await expect(insert(`${"a".repeat(250)}@x.io`)).rejects.toThrow(/accountant_client_links_email_check/);
    await expect(insert("not an email")).rejects.toThrow(/accountant_client_links_email_check/);
  });

  it("names a workspace only on a used link", async () => {
    await expect(
      db.query("insert into public.accountant_client_links (created_by, token_hash, expires_at, org_id) values ($1, $2, now() + interval '7 days', $3)", [accountant, hash(), practice])
    ).rejects.toThrow(/accountant_client_links_org_check/);
  });

  it("has RLS on and no policy", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_catalog.pg_class where oid = 'public.accountant_client_links'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    expect((await db.query("select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'accountant_client_links'")).rows).toHaveLength(0);
  });

  it("lets neither the browser roles nor a tenant read or write it, and the service role read it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.accountant_client_links"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, practice, (tx) => tx.query("select * from public.accountant_client_links"))).rejects.toThrow(/permission denied/);
    const rows = await asServiceRole(db, async (tx) => (await tx.query("select id from public.accountant_client_links where created_by = $1", [accountant])).rows);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("create_client_link (AC1)", () => {
  it("refuses someone who is no workspace's accountant", async () => {
    await expect(create(stranger)).rejects.toThrow(/not_an_accountant/);
    await expect(create(client)).rejects.toThrow(/not_an_accountant/);
  });

  it("makes a one-time link that expires in 7 days, its email lowercased, or bound to no one", async () => {
    const bound = await create(accountant, "  Owner@Client.Example ");
    expect(bound.email).toBe("owner@client.example");
    expect(bound.created_by).toBe(accountant);
    expect(bound.used_at).toBeNull();
    expect(bound.revoked_at).toBeNull();
    const days = (bound.expires_at.getTime() - bound.created_at.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    expect((await create(accountant, "")).email).toBeNull();
    expect((await create(accountant, null)).email).toBeNull();
  });

  it("refuses an address that is not one", async () => {
    await expect(create(accountant, "owner at client")).rejects.toThrow(/invalid_email/);
    await expect(create(accountant, `${"a".repeat(250)}@x.io`)).rejects.toThrow(/invalid_email/);
  });

  it("keeps at most 10 open, and revoking one makes room", async () => {
    const busy = await createUser(db, "open@practice.example");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [practice, busy]);
    const made: LinkRow[] = [];
    for (let i = 0; i < 10; i++) made.push(await create(busy));
    await expect(create(busy)).rejects.toThrow(/client_link_limit_reached/);
    // An expired one is not open.
    await db.query("update public.accountant_client_links set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1", [made[0].id]);
    await expect(create(busy)).resolves.toBeDefined();
    await revoke(busy, made[1].id);
    await expect(create(busy)).resolves.toBeDefined();
  });

  it("makes at most 20 a day, revoked ones counted", async () => {
    for (let round = 0; round < 2; round++) {
      const made: LinkRow[] = [];
      for (let i = 0; i < 10; i++) made.push(await create(books));
      for (const link of made) await revoke(books, link.id);
    }
    await expect(create(books)).rejects.toThrow(/client_link_rate_limited/);
  });
});

describe("revoke_client_link (AC1)", () => {
  it("revokes the accountant's own open link once, and nobody else's", async () => {
    const link = await create(accountant);
    await expect(revoke(stranger, link.id)).rejects.toThrow(/client_link_not_found/);
    const [revoked] = await revoke(accountant, link.id);
    expect(revoked.revoked_at).not.toBeNull();
    await expect(revoke(accountant, link.id)).rejects.toThrow(/client_link_not_found/);
  });
});

describe("client_link_preview (AC2)", () => {
  it("names the accountant and the bound address for an open link only", async () => {
    const tokenHash = hash();
    const link = await create(accountant, "owner@client.example", tokenHash);
    expect(await preview(tokenHash)).toEqual({
      link_id: link.id,
      state: "open",
      accountant_id: accountant,
      accountant_email: "books@practice.example",
      bound_email: "owner@client.example",
      token_hash: tokenHash,
    });
  });

  it("names nothing for an expired, used or revoked link, and finds no unknown one", async () => {
    const expired = hash();
    const old = await create(accountant, "owner@client.example", expired);
    await db.query("update public.accountant_client_links set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1", [old.id]);
    expect(await preview(expired)).toEqual({ link_id: null, state: "expired", accountant_id: null, accountant_email: null, bound_email: null, token_hash: expired });

    const withdrawn = hash();
    const gone = await create(accountant, null, withdrawn);
    await revoke(accountant, gone.id);
    expect((await preview(withdrawn)).state).toBe("revoked");
    expect((await preview(withdrawn)).accountant_email).toBeNull();

    const used = hash();
    await create(accountant, null, used);
    await claim(used, client, await ownedBy(client, "preview-used"));
    expect(await preview(used)).toMatchObject({ state: "used", accountant_email: null, link_id: null });

    expect(await preview(hash())).toBeUndefined();
  });
});

describe("claim_client_link (AC3)", () => {
  it("adds the accountant to the client's new workspace as accountant, marks the link used and records where it came from", async () => {
    const tokenHash = hash();
    const link = await create(accountant, "owner@client.example", tokenHash);
    const orgId = await ownedBy(client, "client-books");
    expect(await claim(tokenHash, client, orgId)).toEqual([{ link_id: link.id, accountant_id: accountant }]);
    expect(await roleIn(orgId, accountant)).toEqual({ role: "accountant", invited_by: client });
    expect(await roleIn(orgId, client)).toEqual({ role: "owner", invited_by: null });
    const row = (await db.query<LinkRow>("select * from public.accountant_client_links where id = $1", [link.id])).rows[0];
    expect(row.used_at).not.toBeNull();
    expect(row.org_id).toBe(orgId);
    const attribution = (await db.query("select utm_source, utm_medium, utm_campaign from public.org_attribution where org_id = $1", [orgId])).rows;
    expect(attribution).toEqual([{ utm_source: "accountant", utm_medium: "client_link", utm_campaign: "accountant_client" }]);
  });

  it("works once", async () => {
    const tokenHash = hash();
    await create(accountant, null, tokenHash);
    await claim(tokenHash, client, await ownedBy(client, "once-a"));
    await expect(claim(tokenHash, client, await ownedBy(client, "once-b"))).rejects.toThrow(/client_link_used/);
  });

  it("refuses an unknown or revoked link, and an expired one", async () => {
    const orgId = await ownedBy(client, "refused-links");
    await expect(claim(hash(), client, orgId)).rejects.toThrow(/client_link_not_found/);
    const withdrawn = hash();
    await revoke(accountant, (await create(accountant, null, withdrawn)).id);
    await expect(claim(withdrawn, client, orgId)).rejects.toThrow(/client_link_not_found/);
    const expired = hash();
    const old = await create(accountant, null, expired);
    await db.query("update public.accountant_client_links set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1", [old.id]);
    await expect(claim(expired, client, orgId)).rejects.toThrow(/client_link_expired/);
    expect(await roleIn(orgId, accountant)).toBeUndefined();
  });

  it("refuses a link bound to another address", async () => {
    const tokenHash = hash();
    await create(accountant, "someone-else@client.example", tokenHash);
    await expect(claim(tokenHash, client, await ownedBy(client, "bound-elsewhere"))).rejects.toThrow(/client_link_email_mismatch/);
  });

  it("refuses the accountant's own link", async () => {
    const tokenHash = hash();
    await create(accountant, null, tokenHash);
    await expect(claim(tokenHash, accountant, await ownedBy(accountant, "own-link"))).rejects.toThrow(/own_client_link/);
  });

  it("refuses a workspace the caller did not create and own", async () => {
    const tokenHash = hash();
    await create(accountant, null, tokenHash);
    // Someone else's workspace, where the caller is an admin.
    const theirs = await ownedBy(stranger, "not-the-clients");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [theirs, client]);
    await expect(claim(tokenHash, client, theirs)).rejects.toThrow(/not_owner/);
    // One the caller made and no longer owns.
    const handed = await ownedBy(client, "handed-over");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [handed, stranger]);
    await db.query("update public.memberships set role = 'admin' where org_id = $1 and user_id = $2", [handed, client]);
    await expect(claim(tokenHash, client, handed)).rejects.toThrow(/not_owner/);
    expect(await roleIn(theirs, accountant)).toBeUndefined();
    // The link is still open.
    expect((await preview(tokenHash)).state).toBe("open");
  });

  it("refuses an accountant who is a member already", async () => {
    const tokenHash = hash();
    await create(accountant, null, tokenHash);
    const orgId = await ownedBy(client, "already-there");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [orgId, accountant]);
    await expect(claim(tokenHash, client, orgId)).rejects.toThrow(/already_a_member/);
    expect(await roleIn(orgId, accountant)).toEqual({ role: "viewer", invited_by: null });
  });
});

describe("add_live_slice_accountant (AC4)", () => {
  const bring = (fromOrg: string, toOrg: string, actor: string, userId: string) =>
    call<{ added: boolean }>("select public.add_live_slice_accountant($1, $2, $3, $4) as added", [fromOrg, toOrg, actor, userId]);

  /** A live slice as startLiveSlice opens it: made just now by `owner` on Arc mainnet, through create_org. */
  async function sliceOf(owner: string, slug: string): Promise<string> {
    const orgId = await ownedBy(owner, slug);
    await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [orgId]);
    return orgId;
  }

  it("adds an accountant of the shadow workspace to its owner's live slice, as accountant", async () => {
    const shadow = await ownedBy(client, "slice-from");
    await db.query("insert into public.memberships (org_id, user_id, role, invited_by) values ($1, $2, 'accountant', $3), ($1, $4, 'accountant', $3)", [shadow, accountant, client, books]);
    const live = await sliceOf(client, "slice-to");
    expect(await bring(shadow, live, client, accountant)).toEqual([{ added: true }]);
    expect(await roleIn(live, accountant)).toEqual({ role: "accountant", invited_by: client });
    await expect(bring(shadow, live, client, accountant)).rejects.toThrow(/already_a_member/);
    // A second accountant comes along beside the first.
    expect(await bring(shadow, live, client, books)).toEqual([{ added: true }]);
    expect(await roleIn(live, books)).toEqual({ role: "accountant", invited_by: client });
  });

  it("refuses anyone but an owner of both, and anyone but an accountant there", async () => {
    const shadow = await ownedBy(client, "slice-refused-from");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant'), ($1, $3, 'viewer')", [shadow, accountant, stranger]);
    const live = await sliceOf(client, "slice-refused-to");
    const notTheirs = await sliceOf(stranger, "slice-not-theirs");
    await expect(bring(shadow, notTheirs, client, accountant)).rejects.toThrow(/not_owner/);
    await expect(bring(shadow, live, stranger, accountant)).rejects.toThrow(/not_owner/);
    await expect(bring(shadow, live, client, stranger)).rejects.toThrow(/not_an_accountant/);
    expect(await roleIn(live, stranger)).toBeUndefined();
    expect(await roleIn(notTheirs, accountant)).toBeUndefined();
  });

  it("adds only to the slice just opened from the shadow workspace, never to another workspace of its owner", async () => {
    const shadow = await ownedBy(client, "slice-bound-from");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant'), ($1, $3, 'accountant')", [shadow, accountant, books]);
    const refused = async (orgId: string, from = shadow) => {
      await expect(bring(from, orgId, client, accountant)).rejects.toThrow(/not_live_slice/);
      expect(await roleIn(orgId, accountant)).toBeUndefined();
    };

    // An older workspace of theirs on Arc mainnet.
    const older = await sliceOf(client, "slice-bound-older");
    await db.query("update public.orgs set created_at = now() - interval '2 hours' where id = $1", [older]);
    await refused(older);
    // A new one on Arc testnet, as the shadow workspace is.
    await refused(await ownedBy(client, "slice-bound-testnet"));
    // One someone else made, where they are an owner too.
    const coOwned = await sliceOf(stranger, "slice-bound-co-owned");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [coOwned, client]);
    await refused(coOwned);
    // One someone else made and handed to them, with no one else in it now.
    const handed = await sliceOf(stranger, "slice-bound-handed");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [handed, client]);
    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [handed, stranger]);
    await refused(handed);
    // A new one of theirs on Arc mainnet with someone in it who did not come from the shadow workspace.
    const peopled = await sliceOf(client, "slice-bound-peopled");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [peopled, stranger]);
    await refused(peopled);
    // Or with an accountant of the shadow workspace in it under another role, which bringing along never gives.
    const promoted = await sliceOf(client, "slice-bound-promoted");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [promoted, books]);
    await refused(promoted);
    // Nor from a workspace on Arc mainnet, which never opens a slice (startLiveSlice refuses it).
    const mainnetFrom = await sliceOf(client, "slice-bound-mainnet-from");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [mainnetFrom, accountant]);
    const live = await sliceOf(client, "slice-bound-live");
    await refused(live, mainnetFrom);
    // The slice itself takes them.
    expect(await bring(shadow, live, client, accountant)).toEqual([{ added: true }]);
  });
});

describe("deleting an account or a workspace", () => {
  it("takes the accountant's links with their account", async () => {
    const leaving = await createUser(db, "leaving@practice.example");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'accountant')", [practice, leaving]);
    await create(leaving);
    await db.query("delete from auth.users where id = $1", [leaving]);
    expect((await db.query("select 1 from public.accountant_client_links where created_by = $1", [leaving])).rows).toEqual([]);
  });

  it("keeps a used link when its workspace goes, naming none", async () => {
    const tokenHash = hash();
    const link = await create(accountant, null, tokenHash);
    const orgId = await ownedBy(client, "goes-away");
    await claim(tokenHash, client, orgId);
    await db.query("delete from public.orgs where id = $1", [orgId]);
    const row = (await db.query<LinkRow>("select used_at, org_id from public.accountant_client_links where id = $1", [link.id])).rows[0];
    expect(row.org_id).toBeNull();
    expect(row.used_at).not.toBeNull();
  });
});

describe("who may call these functions", () => {
  const FUNCTIONS = ["create_client_link", "revoke_client_link", "client_link_preview", "claim_client_link", "add_live_slice_accountant"];

  it("are security definer with an empty search_path", async () => {
    const rows = (
      await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
        "select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1) order by proname",
        [FUNCTIONS]
      )
    ).rows;
    expect(rows.map((row) => row.proname)).toEqual([...FUNCTIONS].sort());
    for (const row of rows) expect(row, row.proname).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'] });
  });

  it.each(["anon", "authenticated"] as const)("%s cannot execute them", async (role) => {
    await expect(asRole(db, role, (tx) => tx.query("select * from public.client_link_preview($1)", [hash()]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, role, (tx) => tx.query("select * from public.create_client_link($1, null, $2)", [accountant, hash()]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, role, (tx) => tx.query("select * from public.claim_client_link($1, $2, $3)", [hash(), client, practice]))).rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot execute them", async () => {
    await expect(asTenant(db, practice, (tx) => tx.query("select * from public.client_link_preview($1)", [hash()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, practice, (tx) => tx.query("select * from public.revoke_client_link($1, $2)", [accountant, crypto.randomUUID()]))).rejects.toThrow(
      /permission denied/
    );
    await expect(asTenant(db, practice, (tx) => tx.query("select public.add_live_slice_accountant($1, $2, $3, $4)", [practice, practice, client, accountant]))).rejects.toThrow(
      /permission denied/
    );
  });
});

describe("re-running 0143", () => {
  it("runs again without error or loss, as db:migrate runs every file", async () => {
    const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.accountant_client_links")).rows[0].n;
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8"));
    expect(await count()).toBe(before);
    await expect(asTenant(db, practice, (tx) => tx.query("select * from public.accountant_client_links"))).rejects.toThrow(/permission denied/);
  });

  it("redefines no view or function of an earlier migration", () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
    const defined = [...sql.matchAll(/create or replace (?:function|view) public\.(\w+)/g)].map((match) => match[1]).sort();
    expect(defined).toEqual(["add_live_slice_accountant", "claim_client_link", "client_link_preview", "create_client_link", "revoke_client_link"]);
  });
});
