import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/googlesheets", () => ({ exportClosePackToSheetsAction: vi.fn(), disconnectGoogleSheetsAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import GoogleSheetsPanel, { GOOGLE_SHEETS_NOTICES } from "@/components/GoogleSheetsPanel";
import { SheetsExport } from "@/components/close-pack/SheetsExport";
import type { ClosePackSheetsView, GoogleSheetsPanelView } from "@/lib/googlesheets/views";

/**
 * The Google Sheets card in Settings and the close pack page's export control
 * (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS2, GS5, GS6, GS18, "Screens and copy"): the
 * card's five states, its buttons for an owner or admin, every way back from connecting, and the account named by a
 * masked email only; on the close pack page, each view in words, the button for an owner, admin or accountant only, the
 * month's last export and its link, opening in a new tab, and nothing of it printed.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const card = (view: GoogleSheetsPanelView, canManage = true, notice: string | null = null) =>
  decode(renderToStaticMarkup(<GoogleSheetsPanel orgSlug="acme" view={view} canManage={canManage} notice={notice} />));
const URL_OF = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit";
const RECONNECT_WORDS =
  "Google no longer accepts this connection: its access was removed in the Google Account, or it went unused for six months. Reconnect Google Sheets to export close packs again.";
const buttons = (markup: string) => [...markup.matchAll(/<(?:button|a)\b[^>]*>([^]*?)<\/(?:button|a)>/g)].map((match) => text(match[1]).trim()).filter(Boolean);

describe("the Google Sheets card (close pack Sheets GS2, GS6, GS18)", () => {
  it("is headed Google Sheets in words beside a neutral icon, with the guide's section, and no Google mark", () => {
    const markup = card({ state: "not_connected" });
    expect(markup).toContain('id="googlesheets"');
    expect(markup).toContain('aria-labelledby="googlesheets-title"');
    expect(markup).toMatch(/id="googlesheets-title"[^>]*>[^]*?lucide-file-spreadsheet[^]*?Google Sheets/);
    expect(markup).toContain('href="/docs/guides/accountants#export-the-close-pack-to-google-sheets"');
    expect(markup).not.toContain("/brands/");
  });

  it("says when it is not set up, with no button", () => {
    const markup = card({ state: "not_set_up" });
    expect(text(markup)).toContain("Google Sheets is not set up on this deployment yet.");
    expect(markup).not.toContain("/integrations/googlesheets/connect");
  });

  it("offers Connect Google Sheets to an owner or admin when not connected, and says who can to others", () => {
    const markup = card({ state: "not_connected" });
    expect(text(markup)).toContain(
      "Export a month's close pack to a spreadsheet in a Google Drive: one row per payment, each with its signed ledger entry. Vestiarion can open only the spreadsheets it makes."
    );
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/googlesheets\/connect\?org=acme"[^>]*>[^]*?Connect Google Sheets/);
    const other = card({ state: "not_connected" }, false);
    expect(text(other)).toContain("An owner or admin can connect Google Sheets.");
    expect(other).not.toContain("/integrations/googlesheets/connect");
  });

  it("names the connected Drive by its masked email, links the close pack, and offers Disconnect Google Sheets", () => {
    const markup = card({ state: "connected", account: "du***@gmail.com", connectedAt: "Oct 25" });
    const words = text(markup);
    expect(words).toContain("Connected to the Google Drive of du***@gmail.com");
    expect(words).toContain("Connected on Oct 25. An owner, admin or accountant exports a month from Monthly close pack in the Audit log.");
    expect(markup).toMatch(/<a[^>]*href="\/o\/acme\/evidence\/close-pack"[^>]*>Open the monthly close pack<\/a>/);
    expect(words).toContain("Spreadsheets already exported stay in that Google Drive.");
    expect(buttons(markup)).toContain("Disconnect Google Sheets");
    expect(markup).toContain('name="orgSlug" value="acme"');
    const other = card({ state: "connected", account: "du***@gmail.com", connectedAt: "Oct 25" }, false);
    expect(buttons(other)).not.toContain("Disconnect Google Sheets");
    expect(text(other)).toContain("Connected to the Google Drive of du***@gmail.com");
    expect(text(other)).toContain("An owner or admin manages Google Sheets.");
  });

  it("asks to reconnect in Google's words, with Reconnect Google Sheets and Disconnect Google Sheets for an owner or admin", () => {
    const markup = card({ state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS });
    expect(text(markup)).toContain("Google Sheets needs you to reconnect");
    expect(text(markup)).toContain(RECONNECT_WORDS);
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/googlesheets\/connect\?org=acme"[^>]*>[^]*?Reconnect Google Sheets/);
    expect(buttons(markup)).toContain("Disconnect Google Sheets");
    expect(card({ state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS }, false)).not.toContain("/integrations/googlesheets/connect");
  });

  it("says a disconnected Drive keeps its spreadsheets, and offers Connect Google Sheets again", () => {
    const markup = card({ state: "revoked", account: "du***@gmail.com" });
    expect(text(markup)).toContain("Disconnected from du***@gmail.com");
    expect(text(markup)).toContain("Spreadsheets already exported stay in that Google Drive. Nothing more is written to Google Sheets.");
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/googlesheets\/connect\?org=acme"[^>]*>[^]*?Connect Google Sheets/);
    expect(buttons(markup)).not.toContain("Disconnect Google Sheets");
  });

  it("says how connecting went, for every way back", () => {
    expect(GOOGLE_SHEETS_NOTICES).toEqual({
      connected: { tone: "success", text: "Google Sheets is connected. Export a month from Monthly close pack in the Audit log." },
      cancelled: { tone: "error", text: "Connecting Google Sheets was cancelled. Nothing changed." },
      forbidden: { tone: "error", text: "Only an owner or admin connects Google Sheets, from their own browser." },
      other_organisation: { tone: "error", text: "This workspace is connected to another Google account. Disconnect it first, then connect the one you want." },
      scopes: {
        tone: "error",
        text: "Google did not give access to Drive files, so nothing was connected. Connect again and leave the Google Drive box ticked.",
      },
      not_set_up: { tone: "error", text: "Google Sheets is not set up on this deployment yet." },
      failed: { tone: "error", text: "Google Sheets did not finish connecting. Try again in a moment." },
    });
    for (const [code, notice] of Object.entries(GOOGLE_SHEETS_NOTICES)) {
      expect(text(card({ state: "not_connected" }, true, code))).toContain(notice.text);
    }
    expect(text(card({ state: "not_connected" }, true, "made-up"))).not.toMatch(/cancelled|did not finish/);
  });

  it("never shows a full email address", () => {
    for (const view of [
      { state: "connected", account: "du***@gmail.com", connectedAt: "Oct 25" },
      { state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS },
      { state: "revoked", account: "du***@gmail.com" },
    ] as GoogleSheetsPanelView[]) {
      expect(card(view)).not.toMatch(/[A-Za-z0-9._%+-]{3,}@gmail\.com/);
    }
  });
});

describe("the close pack page's export control (close pack Sheets GS5, GS9)", () => {
  const control = (view: ClosePackSheetsView) => decode(renderToStaticMarkup(<SheetsExport orgSlug="acme" month="2026-10" view={view} />));

  it("shows nothing when hidden", () => {
    expect(control({ state: "hidden" })).toBe("");
  });

  it("sends an owner or admin to Settings to connect, and tells an accountant who can", () => {
    const owner = control({ state: "connect", canConnect: true });
    expect(text(owner)).toContain("Connect Google Sheets in Settings to export this month to a spreadsheet.");
    expect(owner).toMatch(/<a[^>]*href="\/o\/acme\/settings#googlesheets"[^>]*>[^]*?Connect Google Sheets/);
    const accountant = control({ state: "connect", canConnect: false });
    expect(text(accountant)).toContain("An owner or admin can connect Google Sheets in Settings, so this month can be exported to a spreadsheet.");
    expect(accountant).not.toContain("/settings#googlesheets");
  });

  it("says when it needs reconnecting, with Reconnect Google Sheets for an owner or admin", () => {
    const owner = control({ state: "reconnect", canConnect: true });
    expect(text(owner)).toContain("Google Sheets needs reconnecting before this month can be exported. An owner or admin can reconnect it in Settings.");
    expect(owner).toMatch(/<a[^>]*href="\/o\/acme\/settings#googlesheets"[^>]*>[^]*?Reconnect Google Sheets/);
    expect(control({ state: "reconnect", canConnect: false })).not.toContain("/settings#googlesheets");
  });

  it("offers Export to Google Sheets with the month, to whoever may export, and names the Drive", () => {
    const markup = control({ state: "ready", account: "du***@gmail.com", canExport: true, last: null });
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>[^]*?lucide-file-spreadsheet[^]*?Export to Google Sheets<\/button>/);
    expect(markup).toContain('name="month" value="2026-10"');
    expect(markup).toContain('name="orgSlug" value="acme"');
    expect(text(markup)).toContain("Writes this month to a spreadsheet in the Google Drive of du***@gmail.com. Exporting the same month again updates that spreadsheet.");
    expect(text(markup)).not.toContain("Last exported");
  });

  it("shows the month's last export and its link to every member, the button only with canExport", () => {
    const last = { at: "2026-10-25 14:03 UTC", payments: 14, url: URL_OF };
    const viewer = control({ state: "ready", account: "du***@gmail.com", canExport: false, last });
    expect(text(viewer)).toContain("Last exported to Google Sheets on 2026-10-25 14:03 UTC: 14 payments.");
    expect(viewer).not.toContain("Export to Google Sheets</button>");
    const link = viewer.match(/<a\b[^>]*>[^]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain(`href="${URL_OF}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noreferrer"');
    expect(text(link)).toContain("Open the spreadsheet");
    expect(text(link)).toContain("(opens in a new tab)");
    expect(text(control({ state: "ready", account: "du***@gmail.com", canExport: true, last: { ...last, payments: 1 } }))).toContain(
      "Last exported to Google Sheets on 2026-10-25 14:03 UTC: 1 payment."
    );
  });

  it("is never printed", () => {
    for (const view of [
      { state: "connect", canConnect: true },
      { state: "reconnect", canConnect: false },
      { state: "ready", account: "du***@gmail.com", canExport: true, last: null },
    ] as ClosePackSheetsView[]) {
      expect(control(view)).toMatch(/^<div[^>]*class="[^"]*print:hidden/);
    }
  });
});
