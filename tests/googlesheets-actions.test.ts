import { beforeEach, describe, expect, it, vi } from "vitest";
import { can } from "@/lib/auth/roles";
import type { Connection } from "@/lib/connectors/connections";
import type { SheetExportOutcome } from "@/lib/googlesheets/export";

/**
 * Exporting a month to Google Sheets and disconnecting it from Settings
 * (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS5, GS11, GS14, "Roles and access", "Screens and
 * copy"): exporting is an owner's, admin's or accountant's (`accounting.book`), disconnecting an owner's or admin's
 * (`integrations.manage`); each reads the role again first and works in the workspace's scope. The answers are words and
 * a link built from a checked id, never a token. Disconnecting revokes at Google only when no other workspace is
 * connected with the same Google account.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorize: vi.fn(),
    revalidate: vi.fn(),
    exportSheet: vi.fn(),
    settings: vi.fn(),
    connectionFor: vi.fn(),
    connectedElsewhere: vi.fn(),
    disconnect: vi.fn(),
    revoke: vi.fn(),
    token: vi.fn(),
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: mocks.authorize }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: mocks.revalidate }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/googlesheets/export", () => ({ exportClosePackToSheet: mocks.exportSheet }));
vi.mock("@/lib/googlesheets/settings", () => ({ googleSheetsSettingsFromEnv: mocks.settings }));
vi.mock("@/lib/googlesheets/provider", () => ({ googleSheetsProvider: () => ({ id: "googlesheets", revoke: mocks.revoke }) }));
vi.mock("@/lib/rate-limit", () => ({ takeClosePackDownloadToken: mocks.token }));
vi.mock("@/lib/connectors/connections", () => ({
  connectionFor: mocks.connectionFor,
  connectedElsewhere: mocks.connectedElsewhere,
  disconnectConnection: mocks.disconnect,
}));

import { disconnectGoogleSheetsAction, exportClosePackToSheetsAction } from "@/app/actions/googlesheets";

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6e01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6e02";
const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${ID}/edit`;
const access = (role: string) => ({
  ok: true,
  user: { id: USER, email: "accountant@ledgerworks.test" },
  membership: { orgId: ORG, slug: "acme", name: "Acme Studio", mode: "live", role, network: "arc-testnet" },
});
const EMPTY = { ok: false, message: "" };
const CONNECTION = {
  id: "conn-sheets", orgId: ORG, provider: "googlesheets", externalOrgId: "07623471185212345678", externalOrgName: "du***@gmail.com", status: "connected",
} as unknown as Connection;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "acme");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockResolvedValue(access("accountant"));
  mocks.settings.mockReturnValue({ clientId: "1234567890-abc123def456.apps.googleusercontent.com", clientSecret: "GOCSPX-the-secret" });
  mocks.token.mockReturnValue(true);
  mocks.connectionFor.mockResolvedValue(CONNECTION);
  mocks.connectedElsewhere.mockResolvedValue(false);
  mocks.revoke.mockResolvedValue(true);
  mocks.disconnect.mockImplementation(async (input: { revoke: (token: string) => Promise<boolean> }) => ({ revokedAtProvider: await input.revoke("1//0g-the-refresh-token") }));
});

describe("exportClosePackToSheetsAction (close pack Sheets GS5, GS11)", () => {
  it("needs accounting.book: an owner, admin or accountant exports; an approver or a viewer is refused with the role message", async () => {
    expect((["owner", "admin", "accountant"] as const).every((role) => can(role, "accounting.book"))).toBe(true);
    expect((["approver", "viewer"] as const).some((role) => can(role, "accounting.book"))).toBe(false);
    mocks.authorize.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }))).toEqual({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "accounting.book");
    expect(mocks.exportSheet).not.toHaveBeenCalled();
  });

  it("exports the month as the person, with their email for the Summary, and answers the count, the account and the link", async () => {
    mocks.exportSheet.mockResolvedValue({ ok: true, spreadsheetId: ID, url: SHEET_URL, payments: 14, created: true, account: "du***@gmail.com" } satisfies SheetExportOutcome);
    const result = await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }));
    expect(result).toEqual({ ok: true, message: "Exported 14 payments to Google Sheets.", sheet: { url: SHEET_URL, account: "du***@gmail.com" } });
    const [input, deps] = mocks.exportSheet.mock.calls[0];
    expect(input).toMatchObject({ orgId: ORG, user: { id: USER, email: "accountant@ledgerworks.test" }, workspace: { slug: "acme", name: "Acme Studio" }, month: { key: "2026-10" } });
    expect(deps.provider).toMatchObject({ id: "googlesheets" });
    expect(mocks.token).toHaveBeenCalledWith(`${USER}:${ORG}`);
    // No revalidation: it would read the whole pack again inside the action's time; the answer holds what changed.
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/ya29\.|1\/\/|GOCSPX/);
  });

  it("revalidates when the export asks for a reconnect, so the card and the page say so", async () => {
    mocks.exportSheet.mockResolvedValue({ ok: false, reason: "reconnect" });
    await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }));
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
    mocks.revalidate.mockClear();
    mocks.exportSheet.mockResolvedValue({ ok: false, reason: "unavailable" });
    await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }));
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("says one payment, and a month with none", async () => {
    mocks.exportSheet.mockResolvedValueOnce({ ok: true, spreadsheetId: ID, url: SHEET_URL, payments: 1, created: false, account: "du***@gmail.com" });
    expect((await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }))).message).toBe("Exported 1 payment to Google Sheets.");
    mocks.exportSheet.mockResolvedValueOnce({ ok: true, spreadsheetId: ID, url: SHEET_URL, payments: 0, created: false, account: "du***@gmail.com" });
    expect((await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }))).message).toBe("Exported this month to Google Sheets: no payment settled in it yet.");
  });

  it("passes no provider when the deployment has no Google client, which the export answers as off", async () => {
    mocks.settings.mockReturnValue(null);
    mocks.exportSheet.mockResolvedValue({ ok: false, reason: "off" });
    expect(await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }))).toEqual({ ok: false, message: "Google Sheets is not set up on this deployment yet." });
    expect(mocks.exportSheet.mock.calls[0][1]).toEqual({ provider: null });
  });

  it("refuses a month that does not read, before anything is read", async () => {
    for (const month of ["", "2026-13", "2019-12", "2999-01", "october", "2026-10' or 1=1"]) {
      expect(await exportClosePackToSheetsAction(EMPTY, form({ month }))).toEqual({ ok: false, message: "Choose a month that has started, from 2020 on." });
    }
    expect(mocks.exportSheet).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("holds a burst with the close pack downloads' token, before the export starts", async () => {
    mocks.token.mockReturnValue(false);
    expect(await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }))).toEqual({ ok: false, message: "Too many close pack exports in a row. Try again in a minute." });
    expect(mocks.exportSheet).not.toHaveBeenCalled();
  });

  it.each([
    ["limited", "Too many close pack exports in the last 10 minutes. Try again later."],
    ["rate_limited", "Google asked Vestiarion to slow down. Try again in a minute."],
    ["unavailable", "Google did not answer. Try again in a moment."],
    ["reconnect", "Google Sheets needs you to reconnect. An owner or admin can reconnect it in Settings."],
    ["drive_full", "That Google Drive is full, so the spreadsheet could not be written. Free some space in it, then export again."],
    ["forbidden", "Google refused to write the spreadsheet in that account. A Google Workspace administrator may have turned Drive off for it."],
    ["mismatch", "The spreadsheet did not read back as written, so the export is not recorded as done. Export again."],
    ["read_failed", "The close pack could not be read. Try again in a moment."],
    ["not_connected", "Google Sheets is not connected to this workspace."],
    ["not_set_up", "Google Sheets is not set up on this deployment yet."],
    ["off", "Google Sheets is not set up on this deployment yet."],
    ["failed", "That did not work. Try again in a moment."],
  ] as const)("answers %s in words", async (reason, words) => {
    mocks.exportSheet.mockResolvedValue({ ok: false, reason });
    expect(await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }))).toEqual({ ok: false, message: words });
  });

  it("asks to try again when something throws, logging no detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.exportSheet.mockRejectedValue(new Error("connection reset for accountant@ledgerworks.test"));
    expect(await exportClosePackToSheetsAction(EMPTY, form({ month: "2026-10" }))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(JSON.stringify(log.mock.calls)).not.toContain("ledgerworks");
    log.mockRestore();
  });
});

describe("disconnectGoogleSheetsAction (close pack Sheets GS14)", () => {
  beforeEach(() => {
    mocks.authorize.mockResolvedValue(access("owner"));
  });

  it("needs integrations.manage: an accountant is refused", async () => {
    expect(can("accountant", "integrations.manage")).toBe(false);
    mocks.authorize.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (accountant) cannot do that." });
    expect(await disconnectGoogleSheetsAction(EMPTY, form({}))).toEqual({ ok: false, message: "Your role in this workspace (accountant) cannot do that." });
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "integrations.manage");
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("revokes at Google and deletes the tokens when no other workspace uses the account", async () => {
    expect(await disconnectGoogleSheetsAction(EMPTY, form({}))).toEqual({ ok: true, message: "Google Sheets is disconnected. Spreadsheets already exported stay in that Google Drive." });
    expect(mocks.connectedElsewhere).toHaveBeenCalledWith("googlesheets", "07623471185212345678", ORG);
    expect(mocks.disconnect).toHaveBeenCalledWith(expect.objectContaining({ connection: CONNECTION, by: USER }));
    expect(mocks.revoke).toHaveBeenCalledWith("1//0g-the-refresh-token");
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("does not revoke when another workspace is connected with the same Google account, and says so", async () => {
    mocks.connectedElsewhere.mockResolvedValue(true);
    expect(await disconnectGoogleSheetsAction(EMPTY, form({}))).toEqual({
      ok: true,
      message:
        "Google Sheets is disconnected from this workspace. Another workspace is connected with the same Google account, so Vestiarion's access there stays until you remove it in that Google Account's settings. Spreadsheets already exported stay in that Google Drive.",
    });
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("says so when Google did not confirm the revoke", async () => {
    mocks.revoke.mockResolvedValue(false);
    expect(await disconnectGoogleSheetsAction(EMPTY, form({}))).toEqual({
      ok: true,
      message: "Google Sheets is disconnected and its tokens are deleted. Google did not confirm the revoke, so remove Vestiarion in that Google Account's settings to be sure.",
    });
  });

  it("says when Google Sheets is not connected, and asks to try again when something fails", async () => {
    mocks.connectionFor.mockResolvedValueOnce(null);
    expect(await disconnectGoogleSheetsAction(EMPTY, form({}))).toEqual({ ok: false, message: "Google Sheets is not connected to this workspace." });
    mocks.connectionFor.mockResolvedValueOnce({ ...CONNECTION, status: "revoked" });
    expect(await disconnectGoogleSheetsAction(EMPTY, form({}))).toEqual({ ok: false, message: "Google Sheets is not connected to this workspace." });
    expect(mocks.disconnect).not.toHaveBeenCalled();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.connectedElsewhere.mockRejectedValueOnce(new Error("rpc down"));
    expect(await disconnectGoogleSheetsAction(EMPTY, form({}))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    // A failure to learn whether the account is shared never revokes.
    expect(mocks.revoke).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("disconnects a connection that needs reconnecting too", async () => {
    mocks.connectionFor.mockResolvedValueOnce({ ...CONNECTION, status: "needs_reconnect" });
    expect((await disconnectGoogleSheetsAction(EMPTY, form({}))).ok).toBe(true);
  });
});
