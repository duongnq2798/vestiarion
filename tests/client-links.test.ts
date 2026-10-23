import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  claimClientLink,
  ClientLinkError,
  clientLinkPreview,
  clientLinkTokenHash,
  createClientLink,
  generateClientLinkToken,
  joinView,
  listClientLinks,
  mayInviteClients,
  revokeClientLink,
  sameTokenHash,
  type ClientLinkPreview,
} from "@/lib/platform/client-links";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/client-links.ts` (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC1-AC3)
 * against a real supabase-js client whose network is a recorder: migration 0143's functions answered as PostgREST would.
 * Only a link's hash ever leaves; a row is trusted only when its hash matches; and before 0143 runs, nothing fails.
 */

const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0de";
const KEPT = "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef";
const LINK = "7c3e9f1a-2b4d-4e6f-8a0b-0000000000e1";
const NOW = new Date("2026-10-23T12:00:00Z");

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function fake(respond: (request: RecordedRequest) => FakeReply | undefined) {
  const recorder = fakeSupabase((request) => {
    const reply = respond(request);
    if (reply) return reply;
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG,
          slug: "client-books",
          name: "Client Books",
          mode: "sandbox",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
        },
      };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return { body: { seq: 1, id: "e1", ts: "2026-10-23T00:00:00Z", actor: "human", domain: "system", action: "x", summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null } };
    }
    return { body: [] };
  });
  return {
    requests: recorder.requests,
    run: <T>(fn: () => Promise<T>) => {
      const saved = process.env.VESTIARION_MASTER_KEYS;
      process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
      return runWith({ config, db: recorder.client, fetch: recorder.fetch }, fn).finally(() => {
        if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
        else process.env.VESTIARION_MASTER_KEYS = saved;
      });
    },
  };
}

const rpc = (requests: RecordedRequest[], name: string) => requests.filter((request) => request.path === `/rest/v1/rpc/${name}`).map((request) => request.body as Record<string, unknown>);
const refusal = (message: string, code = "P0001"): FakeReply => ({ status: 400, body: { code, message, details: null, hint: null } });
const missing = (code: string): FakeReply => ({ status: code === "PGRST202" || code === "PGRST205" ? 404 : 400, body: { code, message: "not there", details: null, hint: null } });

describe("tokens", () => {
  it("makes a vxj_ token of 32 random bytes and keeps the SHA-256 of its secret", () => {
    const { token, tokenHash } = generateClientLinkToken(() => Buffer.alloc(32, 7));
    expect(token).toMatch(/^vxj_[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(crypto.createHash("sha256").update(token.slice(4)).digest("hex"));
    expect(clientLinkTokenHash(token)).toBe(tokenHash);
  });

  it("reads nothing else as a token", () => {
    for (const value of ["", "vxj_short", `vxw_${"a".repeat(43)}`, `vxj_${"a".repeat(43)}x`, `vxj_${"a".repeat(42)}!`, null, 42]) {
      expect(clientLinkTokenHash(value)).toBeNull();
    }
  });

  it("compares hashes in constant time, and only well-formed ones", () => {
    const { tokenHash } = generateClientLinkToken();
    expect(sameTokenHash(tokenHash, tokenHash)).toBe(true);
    expect(sameTokenHash(tokenHash, generateClientLinkToken().tokenHash)).toBe(false);
    expect(sameTokenHash(tokenHash.toUpperCase(), tokenHash)).toBe(false);
    expect(sameTokenHash("", tokenHash)).toBe(false);
  });
});

describe("who may invite a client (AC1)", () => {
  it("is an accountant in at least one workspace", () => {
    expect(mayInviteClients([{ role: "owner" }, { role: "accountant" }])).toBe(true);
    expect(mayInviteClients([{ role: "owner" }, { role: "admin" }, { role: "approver" }, { role: "viewer" }])).toBe(false);
    expect(mayInviteClients([])).toBe(false);
  });
});

describe("createClientLink (AC1)", () => {
  it("sends only the hash, and returns the link once, under /join", async () => {
    const { requests, run } = fake((request) =>
      request.path === "/rest/v1/rpc/create_client_link"
        ? { body: { id: LINK, email: "owner@client.example", expires_at: "2026-10-30T12:00:00Z" } }
        : undefined
    );
    const made = await run(() => createClientLink({ actorId: ACCOUNTANT, email: " Owner@Client.example ", origin: "https://www.vestiarion.xyz/" }));
    expect(made).toMatchObject({ id: LINK, email: "owner@client.example", expiresAt: "2026-10-30T12:00:00Z" });
    expect(made.link).toMatch(/^https:\/\/www\.vestiarion\.xyz\/join\/vxj_[A-Za-z0-9_-]{43}$/);
    const token = made.link.split("/join/")[1];
    const [sent] = rpc(requests, "create_client_link");
    expect(sent).toEqual({ p_actor: ACCOUNTANT, p_email: "Owner@Client.example", p_token_hash: clientLinkTokenHash(token) });
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(token);
  });

  it("sends no address for a link bound to no one", async () => {
    const { requests, run } = fake((request) =>
      request.path === "/rest/v1/rpc/create_client_link" ? { body: { id: LINK, email: null, expires_at: "2026-10-30T12:00:00Z" } } : undefined
    );
    await run(() => createClientLink({ actorId: ACCOUNTANT, email: "   ", origin: "https://www.vestiarion.xyz" }));
    expect(rpc(requests, "create_client_link")[0].p_email).toBeNull();
  });

  it.each([
    ["not_an_accountant: only an accountant", "Only someone who is an accountant in a workspace can invite a client."],
    ["client_link_limit_reached: at most 10", "You already have 10 open client links. Revoke one first."],
    ["client_link_rate_limited: at most 20", "You have made 20 client links in the last 24 hours. Try again tomorrow."],
    ["invalid_email: not an email address", "That does not look like an email address."],
  ])("says %s in words", async (message, words) => {
    const { run } = fake((request) => (request.path === "/rest/v1/rpc/create_client_link" ? refusal(message) : undefined));
    const error = await run(() => createClientLink({ actorId: ACCOUNTANT, email: "", origin: "https://x.test" })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientLinkError);
    expect((error as Error).message).toBe(words);
  });

  it("says the feature is not available yet before migration 0143", async () => {
    const { run } = fake((request) => (request.path === "/rest/v1/rpc/create_client_link" ? missing("PGRST202") : undefined));
    await expect(run(() => createClientLink({ actorId: ACCOUNTANT, email: "", origin: "https://x.test" }))).rejects.toThrow("Client invite links are not available yet.");
  });
});

describe("revokeClientLink (AC1)", () => {
  it("names the actor and the link, and says when it is not theirs or not open", async () => {
    const { requests, run } = fake((request) =>
      request.path === "/rest/v1/rpc/revoke_client_link" ? { body: { id: LINK, email: null, expires_at: "2026-10-30T12:00:00Z" } } : undefined
    );
    await run(() => revokeClientLink({ actorId: ACCOUNTANT, linkId: LINK }));
    expect(rpc(requests, "revoke_client_link")).toEqual([{ p_actor: ACCOUNTANT, p_link_id: LINK }]);

    const refused = fake((request) => (request.path === "/rest/v1/rpc/revoke_client_link" ? refusal("client_link_not_found: no open client link") : undefined));
    await expect(refused.run(() => revokeClientLink({ actorId: ACCOUNTANT, linkId: LINK }))).rejects.toThrow("This link is not valid.");
  });
});

describe("listClientLinks (AC1, AC6)", () => {
  const rows = [
    { id: "l1", email: "owner@client.example", created_at: "2026-10-23T10:00:00Z", expires_at: "2026-10-30T10:00:00Z", used_at: null, revoked_at: null, org_id: null, orgs: null },
    { id: "l2", email: null, created_at: "2026-10-22T10:00:00Z", expires_at: "2026-10-29T10:00:00Z", used_at: "2026-10-22T11:00:00Z", revoked_at: null, org_id: KEPT, orgs: { name: "Kept Co" } },
    { id: "l3", email: null, created_at: "2026-10-21T10:00:00Z", expires_at: "2026-10-28T10:00:00Z", used_at: "2026-10-21T11:00:00Z", revoked_at: null, org_id: ORG, orgs: { name: "Removed Me" } },
    { id: "l4", email: null, created_at: "2026-10-10T10:00:00Z", expires_at: "2026-10-17T10:00:00Z", used_at: null, revoked_at: null, org_id: null, orgs: null },
    { id: "l5", email: null, created_at: "2026-10-20T10:00:00Z", expires_at: "2026-10-27T10:00:00Z", used_at: null, revoked_at: "2026-10-20T12:00:00Z", org_id: null, orgs: null },
  ];

  it("lists the accountant's own links with their state, naming a workspace only while they are still in it", async () => {
    const { requests, run } = fake((request) => (request.path === "/rest/v1/accountant_client_links" ? { body: rows } : undefined));
    const listed = await run(() => listClientLinks(ACCOUNTANT, [{ orgId: KEPT }], NOW));
    expect(requests[0].params.get("created_by")).toBe(`eq.${ACCOUNTANT}`);
    expect(listed.available).toBe(true);
    expect(listed.everUsed).toBe(true);
    expect(listed.links.map((link) => [link.id, link.state, link.workspace])).toEqual([
      ["l1", "open", null],
      ["l2", "used", "Kept Co"],
      ["l3", "used", null],
      ["l4", "expired", null],
      ["l5", "revoked", null],
    ]);
  });

  it("says it is not available before migration 0143", async () => {
    for (const code of ["PGRST205", "42P01"]) {
      const { run } = fake((request) => (request.path === "/rest/v1/accountant_client_links" ? missing(code) : undefined));
      expect(await run(() => listClientLinks(ACCOUNTANT, [], NOW))).toEqual({ available: false, links: [], everUsed: false });
    }
  });

  it("throws on any other failure", async () => {
    const { run } = fake((request) => (request.path === "/rest/v1/accountant_client_links" ? { status: 500, body: { code: "XX000", message: "boom" } } : undefined));
    await expect(run(() => listClientLinks(ACCOUNTANT, [], NOW))).rejects.toThrow("boom");
  });
});

describe("clientLinkPreview (AC2)", () => {
  const { token, tokenHash } = generateClientLinkToken();
  const open = { link_id: LINK, state: "open", accountant_id: ACCOUNTANT, accountant_email: "books@practice.example", bound_email: null, token_hash: tokenHash };

  it("asks nothing for what is not a token", async () => {
    const { requests, run } = fake(() => undefined);
    expect(await run(() => clientLinkPreview("not-a-token"))).toEqual({ state: "invalid" });
    expect(requests).toHaveLength(0);
  });

  it("names the accountant of an open link, looked up by its hash only", async () => {
    const { requests, run } = fake((request) => (request.path === "/rest/v1/rpc/client_link_preview" ? { body: [open] } : undefined));
    expect(await run(() => clientLinkPreview(token))).toEqual({
      state: "open",
      linkId: LINK,
      accountantId: ACCOUNTANT,
      accountantEmail: "books@practice.example",
      boundEmail: null,
    });
    expect(rpc(requests, "client_link_preview")).toEqual([{ p_token_hash: tokenHash }]);
  });

  it("trusts no row whose hash is not the one asked for", async () => {
    const { run } = fake((request) =>
      request.path === "/rest/v1/rpc/client_link_preview" ? { body: [{ ...open, token_hash: generateClientLinkToken().tokenHash }] } : undefined
    );
    expect(await run(() => clientLinkPreview(token))).toEqual({ state: "invalid" });
  });

  it("names nothing for a used, expired, revoked or unknown link", async () => {
    for (const [state, expected] of [["used", "used"], ["expired", "expired"], ["revoked", "invalid"]] as const) {
      const { run } = fake((request) =>
        request.path === "/rest/v1/rpc/client_link_preview"
          ? { body: [{ link_id: null, state, accountant_id: null, accountant_email: null, bound_email: null, token_hash: tokenHash }] }
          : undefined
      );
      expect(await run(() => clientLinkPreview(token))).toEqual({ state: expected });
    }
    const { run } = fake((request) => (request.path === "/rest/v1/rpc/client_link_preview" ? { body: [] } : undefined));
    expect(await run(() => clientLinkPreview(token))).toEqual({ state: "invalid" });
  });

  it("says it is not available before migration 0143", async () => {
    const { run } = fake((request) => (request.path === "/rest/v1/rpc/client_link_preview" ? missing("PGRST202") : undefined));
    expect(await run(() => clientLinkPreview(token))).toEqual({ state: "not_ready" });
  });
});

describe("joinView (AC2)", () => {
  const open: ClientLinkPreview = { state: "open", linkId: LINK, accountantId: ACCOUNTANT, accountantEmail: "books@practice.example", boundEmail: null };
  const client = { id: CLIENT, email: "Owner@Client.example" };

  it("offers the form for an open link bound to no one, or to the signed-in address", () => {
    expect(joinView(open, client)).toEqual({ kind: "open", accountantEmail: "books@practice.example" });
    expect(joinView({ ...open, boundEmail: "owner@client.example" }, client)).toEqual({ kind: "open", accountantEmail: "books@practice.example" });
  });

  it("offers nothing for a link bound to another address, or the accountant's own", () => {
    expect(joinView({ ...open, boundEmail: "someone@else.example" }, client)).toEqual({ kind: "bound_elsewhere" });
    expect(joinView({ ...open, boundEmail: "owner@client.example" }, { id: CLIENT, email: null })).toEqual({ kind: "bound_elsewhere" });
    expect(joinView(open, { id: ACCOUNTANT, email: "books@practice.example" })).toEqual({ kind: "own" });
  });

  it("passes on a dead link's state alone", () => {
    for (const state of ["used", "expired", "invalid", "not_ready"] as const) expect(joinView({ state }, client)).toEqual({ kind: state });
  });
});

describe("claimClientLink (AC3)", () => {
  const { tokenHash } = generateClientLinkToken();

  it("claims by hash for the client's new workspace, and signs member_joined there for the accountant", async () => {
    const { requests, run } = fake((request) =>
      request.path === "/rest/v1/rpc/claim_client_link" ? { body: { link_id: LINK, accountant_id: ACCOUNTANT } } : undefined
    );
    expect(await run(() => claimClientLink({ tokenHash, userId: CLIENT, orgId: ORG }))).toEqual({ linkId: LINK, accountantId: ACCOUNTANT });
    expect(rpc(requests, "claim_client_link")).toEqual([{ p_token_hash: tokenHash, p_user_id: CLIENT, p_org_id: ORG }]);
    const [joined] = rpc(requests, "append_ledger_entry");
    expect(joined).toMatchObject({
      p_org_id: ORG,
      p_action: "member_joined",
      p_summary: "A member joined with the accountant role",
      p_detail: { by: ACCOUNTANT, role: "accountant", clientLinkId: LINK, grantedBy: CLIENT },
    });
    expect(rpc(requests, "append_ledger_entry")).toHaveLength(1);
  });

  it.each([
    ["client_link_used: used", "This link has already been used."],
    ["client_link_expired: expired", "This link has expired. Ask your accountant for a new one."],
    ["own_client_link: own", "This is your own client link. Send it to your client."],
    ["client_link_email_mismatch: elsewhere", "This link was made for a different email address. Sign in with that address to use it."],
    ["not_owner: only the owner", "Only the owner who created the workspace can add their accountant this way."],
  ])("refuses %s, and signs nothing", async (message, words) => {
    const { requests, run } = fake((request) => (request.path === "/rest/v1/rpc/claim_client_link" ? refusal(message) : undefined));
    await expect(run(() => claimClientLink({ tokenHash, userId: CLIENT, orgId: ORG }))).rejects.toThrow(words);
    expect(rpc(requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("still returns the claim when the entry cannot be signed, logging by id only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = fake((request) => {
      if (request.path === "/rest/v1/rpc/claim_client_link") return { body: { link_id: LINK, accountant_id: ACCOUNTANT } };
      if (request.path === "/rest/v1/rpc/append_ledger_entry") return { status: 500, body: { message: "ledger unavailable" } };
      return undefined;
    });
    expect(await run(() => claimClientLink({ tokenHash, userId: CLIENT, orgId: ORG }))).toEqual({ linkId: LINK, accountantId: ACCOUNTANT });
    expect(error).toHaveBeenCalledWith("ledger entry not recorded", "member_joined", ORG);
    expect(JSON.stringify(error.mock.calls)).not.toContain(tokenHash);
    error.mockRestore();
  });
});
