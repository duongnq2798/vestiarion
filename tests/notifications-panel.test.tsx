import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/telegram", () => ({ connectTelegramAction: vi.fn(), disconnectTelegramAction: vi.fn() }));
vi.mock("@/app/actions/notifications", () => ({ setNotifyEmailAction: vi.fn(), sendWeeklyBriefNowAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import NotificationsPanel from "@/components/NotificationsPanel";

/**
 * Settings' Notifications section: the viewer's own ways of hearing from the workspace, for every member. The email
 * switch is for someone who decides payments, since a viewer receives no email; the Telegram card is there whenever
 * the deployment has a bot.
 */
describe("NotificationsPanel", () => {
  it("gives someone who decides payments the email switch, and the Telegram card when the deployment has a bot", () => {
    const markup = renderToStaticMarkup(<NotificationsPanel orgSlug="acme" canDecide notifyEmail telegram={{ link: null }} />);
    expect(markup).toContain('id="notifications"');
    expect(markup).toContain(">Notifications<");
    expect(markup).toContain("Email me when payments need a decision");
    expect(markup).toContain("Connect Telegram");
    // This week's brief, sent at once to them (weekly brief W4).
    expect(markup).toContain("Send me this week&#x27;s summary");
  });

  it("gives a viewer only their Telegram chat", () => {
    const markup = renderToStaticMarkup(<NotificationsPanel orgSlug="acme" canDecide={false} notifyEmail={false} telegram={{ link: null }} />);
    expect(markup).not.toContain("Email me when payments need a decision");
    expect(markup).not.toContain("this week&#x27;s summary");
    expect(markup).toContain("Connect Telegram");
  });

  it("leaves out the Telegram card on a deployment without a bot", () => {
    const markup = renderToStaticMarkup(<NotificationsPanel orgSlug="acme" canDecide notifyEmail={false} telegram={null} />);
    expect(markup).toContain("Email me when payments need a decision");
    expect(markup).not.toContain("Telegram");
  });

  it("shows nothing when the viewer has neither", () => {
    expect(renderToStaticMarkup(<NotificationsPanel orgSlug="acme" canDecide={false} notifyEmail={false} telegram={null} />)).toBe("");
  });
});
