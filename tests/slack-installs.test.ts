import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { decryptSecret, parseMasterKeys } from "@/lib/secrets";
import {
  botTokenOf, installFor, installOfTeam, moveCursor, removeInstall, saveInstall, setDecisionsLimit, webhookUrlOf, type SlackInstall,
} from "@/lib/slack/installs";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * A workspace's Slack install (Slack design S3, S8, S13): one Slack team per workspace; the bot token and the webhook's
 * URL kept only as envelopes bound to the workspace and column; a cursor at the ledger's head so the channel is never
 * sent the past; the installer linked at once; and every change in the ledger with ids only.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f01";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f02";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f3";
const INSTALL_ID = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f4";
const WEBHOOK = "https://hooks.slack.com/services/T0TEAM/B0HOOK/abcdefghijklmnopqrstuvwx";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const GRANT = {
  teamId: "T0TEAM", teamName: "Northstar", appId: "A0APP", botUserId: "U0BOT", botToken: "xoxb-1-2-abc",
  installerSlackUserId: "U0LINH", webhookUrl: WEBHOOK, channelId: "C0FINANCE", channelName: "#finance",
};

function installRow(fields: Record<string, unknown> = {}) {
  return {
    id: INSTALL_ID, org_id: ORG, team_id: "T0TEAM", team_name: "Northstar", app_id: "A0APP", channel_id: "C0FINANCE", channel_name: "#finance",
    installed_by: USER, installed_at: "2026-10-03T08:00:00Z", notified_seq: "40", decisions_limit_usdc: null,
    bot_token_enc: { k: "t1", iv: "", tag: "", ct: "" }, webhook_url_enc: { k: "t1", iv: "", tag: "", ct: "" }, ...fields,
  };
}

const INSTALL: SlackInstall = {
  id: INSTALL_ID, orgId: ORG, teamId: "T0TEAM", teamName: "Northstar", appId: "A0APP", botUserId: "U0BOT", channelId: "C0FINANCE", channelName: "#finance",
  installedBy: USER, installedAt: "2026-10-03T08:00:00Z", notifiedSeq: 40, decisionsLimitUsdc: null,
  botTokenEnc: { k: "t1", iv: "", tag: "", ct: "" }, webhookUrlEnc: { k: "t1", iv: "", tag: "", ct: "" },
};

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    // The ledger's head as the install reads it; the ledger's own reads (its key check) see an empty chain.
    if (sent.path === "/rest/v1/ledger_entries") return { body: sent.params.get("select") === "seq" ? [{ seq: 77 }] : [] };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { fake, run };
}

const ledger = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_summary: string; p_detail: Record<string, unknown> });
const writes = (requests: RecordedRequest[], table: string, method: string) => requests.filter((sent) => sent.path === `/rest/v1/${table}` && sent.method === method);

describe("saveInstall", () => {
  it("refuses a Slack team that serves another workspace, and writes nothing", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/slack_installs" && sent.method === "GET" && sent.params.get("team_id") ? { body: [installRow({ org_id: OTHER_ORG })] } : undefined));
    expect(await run(() => saveInstall({ orgId: ORG, installedBy: USER, grant: GRANT }))).toEqual({ ok: false, reason: "team_taken" });
    expect(fake.requests.filter((sent) => sent.method !== "GET" && sent.path !== "/rest/v1/orgs")).toEqual([]);
  });

  it("stores the token and the webhook only as envelopes, the cursor at the ledger's head, and links the installer", async () => {
    let saved: Record<string, unknown> = {};
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/slack_installs" && sent.method === "POST") {
        saved = sent.body as Record<string, unknown>;
        return { body: [{ ...installRow(), ...saved, id: INSTALL_ID }] };
      }
      if (sent.path === "/rest/v1/slack_links" && sent.method === "POST") return { body: [{ id: "link-1" }] };
      return undefined;
    });
    const result = await run(() => saveInstall({ orgId: ORG, installedBy: USER, grant: GRANT }));
    expect(result.ok).toBe(true);

    expect(saved).toMatchObject({ org_id: ORG, team_id: "T0TEAM", app_id: "A0APP", channel_id: "C0FINANCE", installed_by: USER, notified_seq: 77 });
    expect(JSON.stringify(saved)).not.toContain("xoxb-1-2-abc");
    expect(JSON.stringify(saved)).not.toContain("hooks.slack.com");
    const keys = parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
    expect(decryptSecret(saved.bot_token_enc as never, { orgId: ORG, column: "slack_installs.bot_token_enc" }, keys)).toBe("xoxb-1-2-abc");
    expect(decryptSecret(saved.webhook_url_enc as never, { orgId: ORG, column: "slack_installs.webhook_url_enc" }, keys)).toBe(WEBHOOK);

    const [link] = writes(fake.requests, "slack_links", "POST");
    expect(link.body).toEqual({ org_id: ORG, user_id: USER, team_id: "T0TEAM", slack_user_id: "U0LINH" });
    const actions = ledger(fake.requests);
    expect(actions.map((entry) => entry.p_action)).toEqual(["slack_installed", "slack_member_connected"]);
    expect(actions[0].p_detail).toEqual({ by: USER, teamId: "T0TEAM", channelId: "C0FINANCE" });
    expect(JSON.stringify(actions)).not.toContain("Northstar");
    expect(JSON.stringify(actions)).not.toContain("hooks.slack.com");
  });

  it("replaces the workspace's install of another Slack team, whose links go with it", async () => {
    const { fake, run } = world((sent) => {
      if (sent.path === "/rest/v1/slack_installs" && sent.method === "GET" && sent.params.get("org_id")) return { body: [installRow({ team_id: "T0OLD" })] };
      if (sent.path === "/rest/v1/slack_installs" && sent.method === "POST") return { body: [installRow()] };
      return undefined;
    });
    await run(() => saveInstall({ orgId: ORG, installedBy: USER, grant: GRANT }));
    const [removed] = writes(fake.requests, "slack_installs", "DELETE");
    expect(removed.params.get("id")).toBe(`eq.${INSTALL_ID}`);
  });
});

describe("the install afterwards", () => {
  it("reads its webhook and token back from their envelopes", async () => {
    let saved: Record<string, unknown> = {};
    const { run } = world((sent) => {
      if (sent.path === "/rest/v1/slack_installs" && sent.method === "POST") {
        saved = sent.body as Record<string, unknown>;
        return { body: [{ ...installRow(), ...saved }] };
      }
      return undefined;
    });
    const result = await run(() => saveInstall({ orgId: ORG, installedBy: USER, grant: GRANT }));
    if (!result.ok) throw new Error("not saved");
    expect(webhookUrlOf(result.install)).toBe(WEBHOOK);
    expect(botTokenOf(result.install)).toBe("xoxb-1-2-abc");
  });

  it("is found by workspace or by team, with its limit as a number", async () => {
    const { run } = world((sent) => (sent.path === "/rest/v1/slack_installs" ? { body: [installRow({ decisions_limit_usdc: "5.000000" })] } : undefined));
    const byOrg = (await run(() => installFor(ORG))) as SlackInstall;
    expect(byOrg).toMatchObject({ id: INSTALL_ID, orgId: ORG, teamId: "T0TEAM", channelName: "#finance", notifiedSeq: 40, decisionsLimitUsdc: 5 });
    expect(await run(() => installOfTeam("T0TEAM"))).toMatchObject({ orgId: ORG });
    const { run: none } = world((sent) => (sent.path === "/rest/v1/slack_installs" ? { body: [] } : undefined));
    expect(await none(() => installFor(ORG))).toBeNull();
  });

  it("sets or clears the limit, and says so in the ledger", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/slack_installs" && sent.method === "PATCH" ? { body: [{ id: INSTALL_ID }] } : undefined));
    await run(() => setDecisionsLimit(INSTALL, 5, USER));
    const [update] = writes(fake.requests, "slack_installs", "PATCH");
    expect(update.body).toEqual({ decisions_limit_usdc: 5 });
    expect(ledger(fake.requests)[0]).toMatchObject({ p_action: "slack_decisions_limit_changed", p_detail: { by: USER, from: null, to: 5 } });
  });

  it("moves the cursor only forward", async () => {
    const { fake, run } = world();
    await run(() => moveCursor(INSTALL_ID, 90));
    const [update] = writes(fake.requests, "slack_installs", "PATCH");
    expect(update.body).toEqual({ notified_seq: 90 });
    expect(update.params.get("notified_seq")).toBe("lt.90");
  });

  it("removes the install and its links, saying from where", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/slack_installs" && sent.method === "DELETE" ? { body: [{ id: INSTALL_ID }] } : undefined));
    expect(await run(() => removeInstall(INSTALL, "settings", USER))).toBe(true);
    expect(ledger(fake.requests)[0]).toMatchObject({ p_action: "slack_uninstalled", p_detail: { by: USER, teamId: "T0TEAM", via: "settings" } });
  });
});
