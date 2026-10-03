import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  connectSlackAccountAction, disconnectSlackAccountAction, removeSlackAction, setSlackDecisionsLimitAction, type SlackActionResult,
} from "@/app/actions/slack";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The Slack server actions (Slack design S3, S4, S8, S13): each authorizes the session first, with the permission it
 * needs: an owner or admin removes the install, an owner alone sets the limit on deciding payments from Slack, and any
 * member connects or disconnects their own Slack account, never anyone else's.
 */

const { ORG, USER, mocks } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000ca1",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-000000000ca2",
  mocks: {
    authorize: vi.fn(), installFor: vi.fn(), removeInstall: vi.fn(), setDecisionsLimit: vi.fn(), botTokenOf: vi.fn(),
    linkFor: vi.fn(), unlink: vi.fn(), linkMember: vi.fn(), uninstallApp: vi.fn(), revalidate: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: mocks.authorize }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: mocks.revalidate }));
vi.mock("@/lib/slack/installs", () => ({
  installFor: mocks.installFor, removeInstall: mocks.removeInstall, setDecisionsLimit: mocks.setDecisionsLimit, botTokenOf: mocks.botTokenOf,
}));
vi.mock("@/lib/slack/links", () => ({ linkFor: mocks.linkFor, unlink: mocks.unlink, linkMember: mocks.linkMember }));
vi.mock("@/lib/slack/api", () => ({ uninstallApp: mocks.uninstallApp }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
vi.mock("@/lib/dal/scope", async () => {
  const { orgTestContext } = await import("./support/fake-supabase");
  return { inOrg: (_access: unknown, fn: () => Promise<unknown>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG, userId: USER }), fn) };
});

const INSTALL = { id: "inst-1", orgId: ORG, teamId: "T0TEAM", decisionsLimitUsdc: null };
const LINK = { id: "link-1", orgId: ORG, userId: USER, teamId: "T0TEAM", slackUserId: "U0LINH", linkedAt: "2026-10-03T09:00:00Z" };
const INITIAL: SlackActionResult = { ok: false, message: "" };
const access = (role: string) => ({ ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "acme", name: "Acme", mode: "live", role } });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "acme");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  process.env.SLACK_CLIENT_ID = "1234.5678";
  process.env.SLACK_CLIENT_SECRET = "client-secret";
  process.env.SLACK_SIGNING_SECRET = "signing-secret";
});

describe("removeSlackAction", () => {
  it("asks for integrations.manage, uninstalls the app from Slack, and removes the install", async () => {
    mocks.authorize.mockResolvedValue(access("admin"));
    mocks.installFor.mockResolvedValue(INSTALL);
    mocks.botTokenOf.mockReturnValue("xoxb-1");
    mocks.uninstallApp.mockResolvedValue(true);
    mocks.removeInstall.mockResolvedValue(true);
    expect(await removeSlackAction(INITIAL, form({}))).toEqual({ ok: true, message: "Slack is disconnected. The agent's decisions no longer go there." });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "integrations.manage");
    expect(mocks.uninstallApp).toHaveBeenCalledWith(expect.objectContaining({ clientId: "1234.5678" }), "xoxb-1");
    expect(mocks.removeInstall).toHaveBeenCalledWith(INSTALL, "settings", USER);
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("still removes the install when Slack could not be told", async () => {
    mocks.authorize.mockResolvedValue(access("owner"));
    mocks.installFor.mockResolvedValue(INSTALL);
    mocks.botTokenOf.mockImplementation(() => {
      throw new Error("no master key");
    });
    mocks.removeInstall.mockResolvedValue(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await removeSlackAction(INITIAL, form({}))).ok).toBe(true);
    expect(mocks.removeInstall).toHaveBeenCalled();
    error.mockRestore();
  });

  it("returns the refusal when authorize refuses, and removes nothing", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    expect(await removeSlackAction(INITIAL, form({}))).toEqual({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    expect(mocks.removeInstall).not.toHaveBeenCalled();
  });
});

describe("setSlackDecisionsLimitAction", () => {
  it("is an owner's: sets a limit in USDC, or turns deciding from Slack off when left empty", async () => {
    mocks.authorize.mockResolvedValue(access("owner"));
    mocks.installFor.mockResolvedValue(INSTALL);
    expect(await setSlackDecisionsLimitAction(INITIAL, form({ limit: "5" }))).toEqual({
      ok: true, message: "Payments up to 5 USDC can now be decided from Slack, under every check Vestiarion makes.",
    });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "org.administer");
    expect(mocks.setDecisionsLimit).toHaveBeenLastCalledWith(INSTALL, 5, USER);
    expect(await setSlackDecisionsLimitAction(INITIAL, form({ limit: " " }))).toEqual({ ok: true, message: "Deciding payments from Slack is off." });
    expect(mocks.setDecisionsLimit).toHaveBeenLastCalledWith(INSTALL, null, USER);
  });

  it("refuses an amount that is not a positive USDC amount", async () => {
    mocks.authorize.mockResolvedValue(access("owner"));
    mocks.installFor.mockResolvedValue(INSTALL);
    for (const limit of ["0", "-1", "abc", "1.1234567", "2000000"]) {
      expect((await setSlackDecisionsLimitAction(INITIAL, form({ limit }))).ok).toBe(false);
    }
    expect(mocks.setDecisionsLimit).not.toHaveBeenCalled();
  });

  it("says Slack is not connected when there is no install", async () => {
    mocks.authorize.mockResolvedValue(access("owner"));
    mocks.installFor.mockResolvedValue(null);
    expect(await setSlackDecisionsLimitAction(INITIAL, form({ limit: "5" }))).toEqual({ ok: false, message: "Slack is not connected to this workspace." });
  });
});

describe("the member's own Slack account", () => {
  it("connects with the code from Slack, as the signed-in member", async () => {
    mocks.authorize.mockResolvedValue(access("viewer"));
    mocks.linkMember.mockResolvedValue(LINK);
    expect(await connectSlackAccountAction(INITIAL, form({ code: "c".repeat(43) }))).toEqual({
      ok: true, message: "Connected. Back in Slack, try /vestiarion today.",
    });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "workspace.read");
    expect(mocks.linkMember).toHaveBeenCalledWith("c".repeat(43), ORG, USER);
  });

  it("says a used, expired or foreign code is", async () => {
    mocks.authorize.mockResolvedValue(access("viewer"));
    mocks.linkMember.mockResolvedValue(null);
    const result = await connectSlackAccountAction(INITIAL, form({ code: "c".repeat(43) }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("/vestiarion connect");
  });

  it("disconnects only the signed-in member's own account", async () => {
    mocks.authorize.mockResolvedValue(access("approver"));
    mocks.linkFor.mockResolvedValue(LINK);
    mocks.unlink.mockResolvedValue(true);
    expect(await disconnectSlackAccountAction(INITIAL, form({ userId: "someone-else" }))).toEqual({ ok: true, message: "Your Slack account is disconnected." });
    expect(mocks.linkFor).toHaveBeenCalledWith(ORG, USER);
    expect(mocks.unlink).toHaveBeenCalledWith(LINK, "settings", USER);
  });
});
