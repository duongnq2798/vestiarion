import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramActionResult } from "@/app/actions/telegram";

vi.mock("@/app/actions/telegram", () => ({ connectTelegramAction: vi.fn(), disconnectTelegramAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/** A connect result, put in place of the form's initial one when a test sets it. */
const result = vi.hoisted(() => ({ state: null as TelegramActionResult | null }));
vi.mock("@/components/ui/useActionForm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/useActionForm")>();
  return {
    ...actual,
    useActionForm: ((...args: Parameters<typeof actual.useActionForm>) => {
      const real = actual.useActionForm(...args);
      return result.state ? { ...real, state: result.state } : real;
    }) as typeof actual.useActionForm,
  };
});

import { TelegramCard } from "@/components/TelegramCard";

/** The Telegram card in Settings' Notifications section (Telegram bot design R4, R6), as the server renders it. */
describe("TelegramCard", () => {
  afterEach(() => {
    result.state = null;
  });

  it("offers to connect a chat that is not connected, and says the bot never pays", () => {
    const markup = renderToStaticMarkup(<TelegramCard orgSlug="acme" link={null} />);
    expect(markup).toContain("Connect Telegram");
    expect(markup).toContain("never approves or pays");
    expect(markup).not.toContain("Disconnect");
  });

  it("shows the one-time link once it is made, and how long it works", () => {
    result.state = { ok: true, message: "Open Telegram to finish connecting.", url: "https://t.me/vestiarion_bot?start=abc", expiresAt: "2026-10-03T08:10:00Z" };
    const markup = renderToStaticMarkup(<TelegramCard orgSlug="acme" link={null} />);
    expect(markup).toMatch(/<a[^>]*href="https:\/\/t\.me\/vestiarion_bot\?start=abc"[^>]*>/);
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("works once, for 10 minutes");
  });

  it("names the connected Telegram account, and offers to disconnect it", () => {
    const markup = renderToStaticMarkup(<TelegramCard orgSlug="acme" link={{ username: "linh_ops", linkedAt: "2026-10-03T08:00:00Z" }} />);
    expect(markup).toContain("Connected as @linh_ops since Oct 3");
    expect(markup).toContain("Disconnect");
    expect(markup).not.toContain("Connect Telegram");
  });
});
