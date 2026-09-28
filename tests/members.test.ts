import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteOrigin } from "@/lib/auth/env";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  acceptInvitation,
  changeMemberRole,
  hashInvitationToken,
  inviteMember,
  MemberError,
  memberErrorFrom,
  removeMember,
} from "@/lib/platform/members";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/members.ts` against a real supabase-js client whose
 * network is a recorder, the same shape as `tests/workspace.test.ts`: the
 * RPCs from migration 0021 are answered as PostgREST would, and
 * `@/lib/email/send` is stubbed so the tests control whether a send
 * "succeeds".
 */

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock }));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0de";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const TARGET = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
const savedSiteUrl = process.env.SITE_URL;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  process.env.SITE_URL = "https://tests.vestiarion.xyz";
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  if (savedSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = savedSiteUrl;
  sendEmailMock.mockReset();
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

/** PostgREST as `members.ts` meets it: the 0021 RPCs and `append_ledger_entry`. */
function membersFake(options: {
  inviteMember?: (request: RecordedRequest) => FakeReply | undefined;
  acceptInvitation?: (request: RecordedRequest) => FakeReply | undefined;
  changeMemberRole?: (request: RecordedRequest) => FakeReply | undefined;
  removeMember?: (request: RecordedRequest) => FakeReply | undefined;
} = {}) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };

    if (request.path === "/rest/v1/rpc/invite_member") {
      const failure = options.inviteMember?.(request);
      if (failure) return failure;
      const body = request.body as Record<string, unknown>;
      return {
        body: {
          id: "inv-1",
          org_id: body.p_org_id,
          email: (body.p_email as string).toLowerCase(),
          role: body.p_role,
          token_hash: body.p_token_hash,
          invited_by: body.p_actor,
          expires_at: "2026-10-05T12:00:00Z",
          accepted_at: null,
          created_at: "2026-09-28T00:00:00Z",
        },
      };
    }
    if (request.path === "/rest/v1/rpc/accept_invitation") {
      const failure = options.acceptInvitation?.(request);
      if (failure) return failure;
      return { body: { org_id: ORG, slug: "northstar", role: "approver", invitation_id: "inv-1" } };
    }
    if (request.path === "/rest/v1/rpc/change_member_role") {
      const failure = options.changeMemberRole?.(request);
      if (failure) return failure;
      return { body: "viewer" };
    }
    if (request.path === "/rest/v1/rpc/remove_member") {
      const failure = options.removeMember?.(request);
      if (failure) return failure;
      const body = request.body as Record<string, unknown>;
      return { body: body.p_actor === body.p_user_id ? "owner" : "approver" };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-28T00:00:00Z", actor: "human", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((request) => request.path === `/rest/v1/rpc/${name}`).map((request) => request.body as Record<string, unknown>);
}

describe("inviteMember", () => {
  it("hashes the token (never sending it), appends member_invited, and returns the link", async () => {
    sendEmailMock.mockResolvedValueOnce({ sent: true, id: "msg_1" });
    const { fake, run } = membersFake();

    const result = await run(() =>
      withOrg(ORG, () => inviteMember({ actorId: ACTOR, orgName: "Northstar", email: "New@Example.com", role: "approver", token: "fixed-token" }))
    );

    const [invite] = rpcBodies(fake.requests, "invite_member");
    expect(invite).toEqual({
      p_org_id: ORG, p_actor: ACTOR, p_email: "New@Example.com", p_role: "approver",
      p_token_hash: hashInvitationToken("fixed-token"),
    });
    expect(JSON.stringify(fake.requests.map((request) => request.body))).not.toContain("fixed-token");

    expect(result.link).toBe(`${siteOrigin()}/invite/fixed-token`);
    expect(result.emailed).toBe(true);
    expect(result.invitationId).toBe("inv-1");

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      p_action: "member_invited",
      p_summary: "Invitation sent for the approver role",
      p_detail: { by: ACTOR, invitationId: "inv-1", role: "approver" },
    });
    const appendsJson = JSON.stringify(appends);
    expect(appendsJson).not.toContain("New@Example.com");
    expect(appendsJson).not.toContain("new@example.com");
  });

  it("returns emailed: false, and still returns the link, when email is not configured", async () => {
    sendEmailMock.mockResolvedValueOnce({ sent: false, reason: "not_configured" });
    const { run } = membersFake();

    const result = await run(() =>
      withOrg(ORG, () => inviteMember({ actorId: ACTOR, orgName: "Northstar", email: "new@example.com", role: "viewer", token: "another-token" }))
    );

    expect(result.emailed).toBe(false);
    expect(result.link).toBe(`${siteOrigin()}/invite/another-token`);
  });

  it("throws a MemberError with the table's message on a role_not_assignable refusal, and appends nothing", async () => {
    const { fake, run } = membersFake({
      inviteMember: () => ({ status: 400, body: { code: "P0001", message: "role_not_assignable: a viewer cannot invite a admin", details: null, hint: null } }),
    });

    const attempt = run(() =>
      withOrg(ORG, () => inviteMember({ actorId: ACTOR, orgName: "Northstar", email: "new@example.com", role: "admin", token: "tok3" }))
    );
    await expect(attempt).rejects.toBeInstanceOf(MemberError);
    await expect(attempt).rejects.toThrow("Your role cannot grant or change that role.");
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("memberErrorFrom", () => {
  it("maps the 0020 last-owner trigger's text to last_owner", () => {
    const error = memberErrorFrom({ message: "the last owner of an organization cannot be removed or demoted" });
    expect(error).toBeInstanceOf(MemberError);
    expect(error?.code).toBe("last_owner");
    expect(error?.message).toBe("A workspace must keep at least one owner.");
  });

  it("returns null for a message it does not recognize", () => {
    expect(memberErrorFrom({ message: "connection refused" })).toBeNull();
  });
});

describe("acceptInvitation", () => {
  it("calls accept_invitation with the hash and the user id, appends member_joined inside the returned org's scope, and returns it", async () => {
    const { fake, run } = membersFake();

    const result = await run(() => acceptInvitation({ token: "accept-tok", userId: TARGET }));

    const [accept] = rpcBodies(fake.requests, "accept_invitation");
    expect(accept).toEqual({ p_token_hash: hashInvitationToken("accept-tok"), p_user_id: TARGET });

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      p_org_id: ORG,
      p_action: "member_joined",
      p_summary: "A member joined as approver",
      p_detail: { by: TARGET, role: "approver", invitationId: "inv-1" },
    });

    expect(result).toEqual({ orgId: ORG, slug: "northstar", role: "approver" });
  });
});

describe("removeMember", () => {
  it("appends member_left when the actor removes themselves", async () => {
    const { fake, run } = membersFake();

    await run(() => withOrg(ORG, () => removeMember({ actorId: ACTOR, userId: ACTOR })));

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends[0]).toMatchObject({
      p_action: "member_left",
      p_summary: "A owner left the workspace",
      p_detail: { by: ACTOR, role: "owner" },
    });
    expect(appends[0].p_detail).not.toHaveProperty("member");
  });

  it("appends member_removed with detail.member when the actor removes someone else", async () => {
    const { fake, run } = membersFake();

    await run(() => withOrg(ORG, () => removeMember({ actorId: ACTOR, userId: TARGET })));

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends[0]).toMatchObject({
      p_action: "member_removed",
      p_summary: "A approver was removed",
      p_detail: { by: ACTOR, member: TARGET, role: "approver" },
    });
  });
});

describe("changeMemberRole", () => {
  it("appends member_role_changed with from = the RPC's previous role and to = the new role", async () => {
    const { fake, run } = membersFake();

    await run(() => withOrg(ORG, () => changeMemberRole({ actorId: ACTOR, userId: TARGET, role: "approver" })));

    const [change] = rpcBodies(fake.requests, "change_member_role");
    expect(change).toEqual({ p_org_id: ORG, p_actor: ACTOR, p_user_id: TARGET, p_role: "approver" });

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends[0]).toMatchObject({
      p_action: "member_role_changed",
      p_summary: "A member's role changed from viewer to approver",
      p_detail: { by: ACTOR, member: TARGET, from: "viewer", to: "approver" },
    });
  });
});
