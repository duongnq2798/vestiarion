import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { SlackInstall } from "@/lib/slack/installs";
import { createLinkRequest, linkFor, linkMember, linkOf, readLinkRequest, slackActor, unlink, type SlackLink } from "@/lib/slack/links";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * A member's own Slack account (Slack design S4, S5): `/vestiarion connect` makes a one-time code whose hash alone is
 * stored, bound to that Slack account; signing in to Vestiarion and connecting uses it up through the database's own
 * function; and every action builds its actor from the membership as it is now, with the install's limit as it is now.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f11";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f12";
const LINK_ID = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f13";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const LINK_ROW = { id: LINK_ID, org_id: ORG, user_id: USER, team_id: "T0TEAM", slack_user_id: "U0LINH", linked_at: "2026-10-03T09:00:00Z" };
const LINK: SlackLink = { id: LINK_ID, orgId: ORG, userId: USER, teamId: "T0TEAM", slackUserId: "U0LINH", linkedAt: "2026-10-03T09:00:00Z" };
const INSTALL = { orgId: ORG, teamId: "T0TEAM", decisionsLimitUsdc: 5 } as SlackInstall;

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { mode: "live" }) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const platform = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  const scoped = <T,>(fn: () => Promise<T>) => platform(() => withOrg(ORG, fn, { userId: USER }));
  return { fake, platform, scoped };
}

const ledger = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_detail: Record<string, unknown> });

describe("link requests", () => {
  it("stores only the SHA-256 of a 43-character code, bound to the Slack account, for ten minutes", async () => {
    const { fake, platform } = world();
    const { code, expiresAt } = await platform(() => createLinkRequest("T0TEAM", "U0LINH", "linh", new Date("2026-10-03T09:00:00Z")));
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe("2026-10-03T09:10:00.000Z");
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/slack_link_requests" && sent.method === "POST");
    expect(insert?.body).toEqual({
      team_id: "T0TEAM", slack_user_id: "U0LINH", slack_user_name: "linh",
      code_hash: crypto.createHash("sha256").update(code).digest("hex"), expires_at: "2026-10-03T09:10:00.000Z",
    });
    expect(JSON.stringify(insert?.body)).not.toContain(code);
  });

  it("reads an unused, unexpired request by its code, and asks nothing for a string that is not a code", async () => {
    const { fake, platform } = world((sent) =>
      sent.path === "/rest/v1/slack_link_requests" ? { body: [{ team_id: "T0TEAM", slack_user_id: "U0LINH", slack_user_name: "linh" }] } : undefined
    );
    const code = "a".repeat(43);
    expect(await platform(() => readLinkRequest(code, new Date("2026-10-03T09:05:00Z")))).toEqual({ teamId: "T0TEAM", slackUserId: "U0LINH", slackUserName: "linh" });
    const read = fake.requests.find((sent) => sent.path === "/rest/v1/slack_link_requests");
    expect(read?.params.get("code_hash")).toBe(`eq.${crypto.createHash("sha256").update(code).digest("hex")}`);
    expect(read?.params.get("used_at")).toBe("is.null");
    expect(read?.params.get("expires_at")).toBe("gt.2026-10-03T09:05:00.000Z");
    const before = fake.requests.length;
    expect(await platform(() => readLinkRequest("../../etc"))).toBeNull();
    expect(fake.requests.length).toBe(before);
  });
});

describe("linkMember", () => {
  it("links through the database's own function, and records it in the workspace's ledger", async () => {
    const { fake, scoped } = world((sent) => (sent.path === "/rest/v1/rpc/slack_link_member" ? { body: [LINK_ROW] } : undefined));
    const code = "b".repeat(43);
    expect(await scoped(() => linkMember(code, ORG, USER))).toEqual(LINK);
    const call = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/slack_link_member");
    expect(call?.body).toEqual({ p_code_hash: crypto.createHash("sha256").update(code).digest("hex"), p_org_id: ORG, p_user_id: USER });
    expect(ledger(fake.requests)).toEqual([expect.objectContaining({ p_action: "slack_member_connected", p_detail: { by: USER, linkId: LINK_ID } })]);
  });

  it("links nothing, and records nothing, for a code the function refused", async () => {
    const { fake, scoped } = world((sent) => (sent.path === "/rest/v1/rpc/slack_link_member" ? { body: [] } : undefined));
    expect(await scoped(() => linkMember("c".repeat(43), ORG, USER))).toBeNull();
    expect(ledger(fake.requests)).toEqual([]);
  });
});

describe("finding and removing a link", () => {
  it("finds a link by Slack account, or by membership", async () => {
    const { fake, platform } = world((sent) => (sent.path === "/rest/v1/slack_links" ? { body: [LINK_ROW] } : undefined));
    expect(await platform(() => linkOf("T0TEAM", "U0LINH"))).toEqual(LINK);
    expect(await platform(() => linkFor(ORG, USER))).toEqual(LINK);
    const [byAccount, byMember] = fake.requests.filter((sent) => sent.path === "/rest/v1/slack_links");
    expect(byAccount.params.get("team_id")).toBe("eq.T0TEAM");
    expect(byAccount.params.get("slack_user_id")).toBe("eq.U0LINH");
    expect(byMember.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("unlinks, saying from where", async () => {
    const { fake, scoped } = world((sent) => (sent.path === "/rest/v1/slack_links" && sent.method === "DELETE" ? { body: [{ id: LINK_ID }] } : undefined));
    expect(await scoped(() => unlink(LINK, "slack", USER))).toBe(true);
    expect(ledger(fake.requests)[0]).toMatchObject({ p_action: "slack_member_disconnected", p_detail: { by: USER, userId: USER, linkId: LINK_ID, via: "slack" } });
  });
});

describe("slackActor", () => {
  it("is the member as they are now, acting through Slack with the install's limit", async () => {
    const { platform } = world((sent) => (sent.path === "/rest/v1/memberships" ? { body: [{ role: "approver" }] } : undefined));
    expect(await platform(() => slackActor(INSTALL, LINK))).toEqual({
      orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "slack", linkId: LINK_ID, decisionsLimitUsdc: 5 },
    });
  });

  it("is nobody once the membership is gone", async () => {
    const { platform } = world((sent) => (sent.path === "/rest/v1/memberships" ? { body: [] } : undefined));
    expect(await platform(() => slackActor(INSTALL, LINK))).toBeNull();
  });
});
