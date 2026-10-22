import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/discord", () => ({ connectDiscordAction: vi.fn(), sendDiscordTestAction: vi.fn(), removeDiscordAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import DiscordPanel from "@/components/DiscordPanel";

/** The Settings section for Discord (docs/superpowers/specs/2026-10-22-discord-design.md DC6), as the server renders it for each role. */
describe("DiscordPanel", () => {
  const connected = {
    available: true as const, connected: true as const, name: "Finance alerts", channelId: "3234567890123456789", connectedAt: "2026-10-22T08:00:00Z",
    connectedByYou: false, lastError: null, lastErrorAt: null,
  };

  it("offers an owner or admin the webhook URL field and Connect, with where to find the URL in Discord", () => {
    const markup = renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={{ available: true, connected: false }} canManage />);
    expect(markup).toContain('name="webhookUrl"');
    expect(markup).toContain('type="url"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain("Webhook URL");
    expect(markup).toContain("Connect");
    expect(markup).toContain("Integrations, Webhooks, New Webhook, and Copy Webhook URL");
    expect(markup).toContain("Opening a link never approves anything");
    expect(markup).toContain('href="/docs/guides/discord"');
  });

  it("tells anyone else who can connect it, with no field", () => {
    const markup = renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={{ available: true, connected: false }} canManage={false} />);
    expect(markup).not.toContain('name="webhookUrl"');
    expect(markup).toContain("An owner or admin can connect Discord.");
  });

  it("says Discord is not set up yet before the migration, to everyone", () => {
    for (const canManage of [true, false]) {
      const markup = renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={{ available: false }} canManage={canManage} />);
      expect(markup).toContain("Discord is not set up on this deployment yet.");
      expect(markup).not.toContain('name="webhookUrl"');
    }
  });

  it("names the webhook and the channel, and when it was connected, as label and value rows", () => {
    const markup = renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={connected} canManage />);
    expect(markup).toMatch(/<dt[^>]*>Webhook<\/dt><dd[^>]*>Finance alerts<\/dd>/);
    expect(markup).toMatch(/<dt[^>]*>Channel id<\/dt><dd[^>]*>3234567890123456789<\/dd>/);
    expect(markup).toMatch(/<dt[^>]*>Connected since<\/dt><dd[^>]*>Oct 22<\/dd>/);
    expect(markup).not.toContain("Last error");
    expect(renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={{ ...connected, connectedByYou: true }} canManage />)).toMatch(
      /<dt[^>]*>Connected since<\/dt><dd[^>]*>Oct 22, by you<\/dd>/
    );
  });

  it("shows the last post Discord did not take, and when", () => {
    const markup = renderToStaticMarkup(
      <DiscordPanel orgSlug="acme" view={{ ...connected, lastError: "Discord answered 503. The bills are posted again with the next cycle.", lastErrorAt: "2026-10-22T09:05:00Z" }} canManage={false} />
    );
    expect(markup).toMatch(/<dt[^>]*>Last error<\/dt><dd[^>]*>Oct 22, 2026, 09:05 UTC: Discord answered 503\./);
  });

  it("offers an owner or admin Send test message and Disconnect, and anyone else neither", () => {
    const manager = renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={connected} canManage />);
    expect(manager).toContain("Send test message");
    expect(manager).toContain("Disconnect");
    expect(manager).not.toContain('name="webhookUrl"');
    const member = renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={connected} canManage={false} />);
    expect(member).not.toContain("Send test message");
    expect(member).not.toContain("Disconnect");
    expect(member).toContain("An owner or admin can connect Discord.");
    expect(member).toContain("Finance alerts");
  });

  it("never shows a webhook URL", () => {
    for (const view of [connected, { available: true as const, connected: false as const }]) {
      expect(renderToStaticMarkup(<DiscordPanel orgSlug="acme" view={view} canManage />)).not.toMatch(/discord\.com\/api\/webhooks\/\d/);
    }
  });
});
