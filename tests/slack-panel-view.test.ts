import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { slackPanelView } from "@/lib/slack/panel";
import { fakeSupabase } from "./support/fake-supabase";

/** What Settings shows of a workspace's Slack (Slack design S3, S8, S15): names, a date, the limit, whether it may read files. */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e02";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function view(scopes: string[] | null) {
  const fake = fakeSupabase((sent) => {
    if (sent.path === "/rest/v1/slack_installs") {
      return {
        body: [{
          id: "inst-1", org_id: ORG, team_id: "T0TEAM", team_name: "Acme HQ", app_id: "A0APP", bot_user_id: "U0BOT", channel_id: "C0FIN", channel_name: "#finance",
          installed_by: USER, installed_at: "2026-10-03T08:00:00Z", notified_seq: 1, decisions_limit_usdc: "5", scopes, bot_token_enc: {}, webhook_url_enc: {},
        }],
      };
    }
    return { body: [] };
  });
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => slackPanelView(ORG, USER));
}

describe("slackPanelView", () => {
  it("says whether the install may read the files someone chooses", async () => {
    expect(await view(["commands", "incoming-webhook", "files:read"])).toMatchObject({ installed: true, decisionsLimitUsdc: 5, canReadFiles: true });
    expect(await view(["commands", "incoming-webhook"])).toMatchObject({ canReadFiles: false });
    expect(await view(null)).toMatchObject({ canReadFiles: false });
  });

  it("carries no secret", async () => {
    const shown = JSON.stringify(await view(["files:read"]));
    expect(shown).not.toContain("bot_token");
    expect(shown).not.toContain("webhook");
  });
});
