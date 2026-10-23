// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordPanelView } from "@/lib/discord/panel";

/**
 * Send test message on a webhook someone deleted in Discord (docs/superpowers/specs/2026-10-22-discord-design.md DC6):
 * the action disconnects Discord and the revalidated page swaps the connected view for Connect in the same render, so
 * the answer is kept in the panel and shown beside Connect, until Connect or Disconnect next answers.
 */

const GONE = "Discord says this webhook no longer exists, so Discord was disconnected. Connect a new webhook.";
const actions = vi.hoisted(() => ({
  connectDiscordAction: vi.fn(),
  sendDiscordTestAction: vi.fn(),
  removeDiscordAction: vi.fn(),
}));
vi.mock("@/app/actions/discord", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import DiscordPanel from "@/components/DiscordPanel";

const CONNECTED: DiscordPanelView = {
  available: true, connected: true, name: "Finance alerts", channelId: "3234567890123456789", connectedAt: "2026-10-22T08:00:00Z",
  connectedByYou: false, lastError: null, lastErrorAt: null,
};
const NOT_CONNECTED: DiscordPanelView = { available: true, connected: false };

let container: HTMLDivElement;
let root: Root;

const show = (view: DiscordPanelView) => act(() => root.render(<DiscordPanel orgSlug="acme" view={view} canManage />));

beforeEach(() => {
  actions.sendDiscordTestAction.mockResolvedValue({ ok: false, disconnected: true, message: GONE });
  actions.connectDiscordAction.mockResolvedValue({ ok: false, message: "Discord says this webhook does not exist." });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
}

describe("DiscordPanel, when Send test message finds the webhook gone", () => {
  it("shows the answer beside Connect once the page swaps the view, never beside the connected webhook", async () => {
    show(CONNECTED);
    await press("Send test message");
    expect(actions.sendDiscordTestAction).toHaveBeenCalledTimes(1);
    // Still the connected view (the page has not come back yet): the answer is not shown beside Send test message.
    expect(container.textContent).not.toContain(GONE);

    show(NOT_CONNECTED);
    expect(container.textContent).toContain(GONE);
  });

  it("drops the answer once Connect answers, so a later disconnect does not show it again", async () => {
    show(CONNECTED);
    await press("Send test message");
    show(NOT_CONNECTED);
    expect(container.textContent).toContain(GONE);

    const field = container.querySelector<HTMLInputElement>('input[name="webhookUrl"]');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    act(() => setter?.call(field, "https://discord.com/api/webhooks/1234567890123456789/token"));
    await press("Connect");
    expect(actions.connectDiscordAction).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain(GONE);
    expect(container.textContent).toContain("Discord says this webhook does not exist.");

    show(CONNECTED);
    show(NOT_CONNECTED);
    expect(container.textContent).not.toContain(GONE);
  });
});
