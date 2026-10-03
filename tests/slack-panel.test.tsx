import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/slack", () => ({
  removeSlackAction: vi.fn(), setSlackDecisionsLimitAction: vi.fn(), disconnectSlackAccountAction: vi.fn(), connectSlackAccountAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import SlackPanel from "@/components/SlackPanel";

/** The Settings section for Slack (Slack design S3, S4, S8, S13), as the server renders it for each role. */
describe("SlackPanel", () => {
  const installed = {
    installed: true as const, teamName: "Acme HQ", channelName: "#finance", installedAt: "2026-10-03T08:00:00Z", decisionsLimitUsdc: null, youConnected: false,
    canReadFiles: true,
  };

  it("offers Add to Slack to an owner or admin, through the install route", () => {
    const markup = renderToStaticMarkup(<SlackPanel orgSlug="acme" view={{ installed: false }} canManage canAdminister={false} notice={null} />);
    expect(markup).toContain('href="/api/slack/install?org=acme"');
    expect(markup).toContain("Add to Slack");
  });

  it("tells anyone else who may connect it", () => {
    const markup = renderToStaticMarkup(<SlackPanel orgSlug="acme" view={{ installed: false }} canManage={false} canAdminister={false} notice={null} />);
    expect(markup).not.toContain("/api/slack/install");
    expect(markup).toContain("An owner or admin connects Slack");
  });

  it("names the Slack workspace and channel, says deciding there is off, and how a member connects", () => {
    const markup = renderToStaticMarkup(<SlackPanel orgSlug="acme" view={installed} canManage canAdminister={false} notice={null} />);
    expect(markup).toContain("Acme HQ");
    expect(markup).toContain("#finance");
    expect(markup).toContain("Deciding payments from Slack is off");
    expect(markup).toContain("/vestiarion connect");
    expect(markup).toContain("Remove");
    expect(markup).not.toContain('name="limit"');
  });

  it("lets an owner set the limit, and says the one set", () => {
    const markup = renderToStaticMarkup(<SlackPanel orgSlug="acme" view={{ ...installed, decisionsLimitUsdc: 5, youConnected: true }} canManage canAdminister notice={null} />);
    expect(markup).toContain('name="limit"');
    expect(markup).toContain("up to 5 USDC");
    expect(markup).toContain("Your Slack account is connected");
    expect(markup).toContain("Disconnect my account");
  });

  it("offers an owner or admin to connect Slack again, through the install route, and nobody else", () => {
    const manager = renderToStaticMarkup(<SlackPanel orgSlug="acme" view={installed} canManage canAdminister={false} notice={null} />);
    expect(manager).toContain("Reconnect Slack");
    expect(manager).toContain('href="/api/slack/install?org=acme"');
    const member = renderToStaticMarkup(<SlackPanel orgSlug="acme" view={installed} canManage={false} canAdminister={false} notice={null} />);
    expect(member).not.toContain("Reconnect Slack");
  });

  it("says Slack must be connected again before an invoice can be added from it, until it may read files", () => {
    const older = renderToStaticMarkup(<SlackPanel orgSlug="acme" view={{ ...installed, canReadFiles: false }} canManage canAdminister={false} notice={null} />);
    expect(older).toContain("To add invoices from Slack, connect Slack again");
    expect(renderToStaticMarkup(<SlackPanel orgSlug="acme" view={installed} canManage canAdminister={false} notice={null} />)).not.toContain(
      "To add invoices from Slack, connect Slack again"
    );
  });

  it("says how connecting went, from Slack's way back", () => {
    expect(renderToStaticMarkup(<SlackPanel orgSlug="acme" view={installed} canManage canAdminister={false} notice="connected" />)).toContain("Slack is connected");
    expect(renderToStaticMarkup(<SlackPanel orgSlug="acme" view={{ installed: false }} canManage canAdminister={false} notice="team_taken" />)).toContain(
      "already connected to another Vestiarion workspace"
    );
  });
});
