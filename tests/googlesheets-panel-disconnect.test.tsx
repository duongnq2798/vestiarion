// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleSheetsPanelView } from "@/lib/googlesheets/views";

/**
 * Disconnect Google Sheets (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS14): the action
 * revalidates the page, so its answer and the card's Disconnected view arrive in the same render. The answer is kept in
 * the card, which stays mounted, and shown beside Connect Google Sheets: the shared-account and unconfirmed-revoke
 * warnings must not vanish with the Disconnect button.
 */

const SHARED =
  "Google Sheets is disconnected from this workspace. Another workspace is connected with the same Google account, so Vestiarion's access there stays until you remove it in that Google Account's settings. Spreadsheets already exported stay in that Google Drive.";
const UNCONFIRMED =
  "Google Sheets is disconnected and its tokens are deleted. Google did not confirm the revoke, so remove Vestiarion in that Google Account's settings to be sure.";
const actions = vi.hoisted(() => ({ exportClosePackToSheetsAction: vi.fn(), disconnectGoogleSheetsAction: vi.fn() }));
vi.mock("@/app/actions/googlesheets", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import GoogleSheetsPanel from "@/components/GoogleSheetsPanel";

const CONNECTED: GoogleSheetsPanelView = { state: "connected", account: "du***@gmail.com", connectedAt: "Oct 25" };
const REVOKED: GoogleSheetsPanelView = { state: "revoked", account: "du***@gmail.com" };

let container: HTMLDivElement;
let root: Root;

const show = (view: GoogleSheetsPanelView) => act(() => root.render(<GoogleSheetsPanel orgSlug="acme" view={view} canManage notice={null} />));

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
}

describe("GoogleSheetsPanel, once Disconnect Google Sheets answers (close pack Sheets GS14)", () => {
  it.each([
    ["another workspace shares the Google account", SHARED],
    ["Google did not confirm the revoke", UNCONFIRMED],
    ["the revoke went through", "Google Sheets is disconnected. Spreadsheets already exported stay in that Google Drive."],
  ])("keeps the answer on the card when %s, after the page turns it Disconnected", async (_case, message) => {
    actions.disconnectGoogleSheetsAction.mockResolvedValue({ ok: true, message });
    show(CONNECTED);
    await press("Disconnect Google Sheets");
    expect(actions.disconnectGoogleSheetsAction).toHaveBeenCalledTimes(1);

    // The revalidated page: the card is Disconnected and the Disconnect button is gone.
    show(REVOKED);
    expect(container.textContent).toContain("Disconnected from du***@gmail.com");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent?.trim())).not.toContain("Disconnect Google Sheets");
    const status = [...container.querySelectorAll('[role="status"]')].find((each) => each.textContent?.includes(message));
    expect(status, "the answer, in a live region").toBeTruthy();
  });

  it("shows a refusal beside the button, the card still connected", async () => {
    actions.disconnectGoogleSheetsAction.mockResolvedValue({ ok: false, message: "That did not work. Try again in a moment." });
    show(CONNECTED);
    await press("Disconnect Google Sheets");
    expect(container.textContent).toContain("That did not work. Try again in a moment.");
    expect(container.querySelector(".text-refused")?.textContent).toContain("That did not work. Try again in a moment.");
  });
});
