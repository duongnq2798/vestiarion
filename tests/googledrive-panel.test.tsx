import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/googledrive", () => ({
  chooseGoogleDriveFolderAction: vi.fn(),
  checkGoogleDriveNowAction: vi.fn(),
  disconnectGoogleDriveAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import GoogleDrivePanel, { GOOGLE_DRIVE_NOTICES } from "@/components/GoogleDrivePanel";
import { googleDriveFolderView, type GoogleDriveFolderView, type GoogleDrivePanelView } from "@/lib/googledrive/views";
import { GOOGLE_DRIVE_FOLDER, GOOGLE_DRIVE_NOW } from "@/app/docs-shots/googledrive-fixture";

/**
 * The Google Drive card in Settings (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD1, GD2, GD4, GD5,
 * GD7, GD13, GD15, GD16), as Google Sheets' card: its five states, the folder chosen by pasting its link, what the last
 * read that did not finish says, the figures, Check Google Drive now for whoever adds invoices, the buttons for an owner
 * or admin, every way back from connecting, and the account named by a masked email only, beside a plain folder icon.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const buttons = (markup: string) => [...markup.matchAll(/<(?:button|a)\b[^>]*>([^]*?)<\/(?:button|a)>/g)].map((match) => text(match[1]).trim()).filter(Boolean);
const card = (view: GoogleDrivePanelView, { canManage = true, canCheck = true, notice = null }: { canManage?: boolean; canCheck?: boolean; notice?: string | null } = {}) =>
  decode(renderToStaticMarkup(<GoogleDrivePanel orgSlug="acme" view={view} canManage={canManage} canCheck={canCheck} notice={notice} />));

const RECONNECT_WORDS =
  "Google no longer accepts this connection: its access was removed in the Google Account. Reconnect Google Drive to go on reading the new files in its folder.";
const FOLDER: GoogleDriveFolderView = googleDriveFolderView(GOOGLE_DRIVE_FOLDER, GOOGLE_DRIVE_NOW);
const FIGURES = { read30d: 3, waiting: 1, added30d: 2 };
const connected = (folder: GoogleDriveFolderView | null, figures = FIGURES): GoogleDrivePanelView => ({
  state: "connected",
  account: "du***@gmail.com",
  connectedAt: "Nov 1",
  folder,
  figures,
});

describe("the Google Drive card (Google Drive intake GD1, GD16)", () => {
  it("is headed Google Drive in words beside a plain folder icon, with its guide, and no Google mark", () => {
    const markup = card({ state: "not_connected" });
    expect(markup).toContain('id="googledrive"');
    expect(markup).toContain('aria-labelledby="googledrive-title"');
    expect(markup).toMatch(/id="googledrive-title"[^>]*>[^]*?lucide-folder\b[^]*?Google Drive/);
    expect(markup).toContain('href="/docs/guides/google-drive"');
    expect(markup).not.toContain("/brands/");
  });

  it("says when it is not set up, with no button", () => {
    const markup = card({ state: "not_set_up" });
    expect(text(markup)).toContain("Google Drive is not set up on this deployment yet.");
    expect(markup).not.toContain("/integrations/googledrive/connect");
  });

  it("offers Connect Google Drive to an owner or admin when not connected, and says who can to others", () => {
    const markup = card({ state: "not_connected" });
    expect(text(markup)).toContain(
      "Bring bills in from a Google Drive folder. Each PDF added to the folder you choose is read into a bill that waits for review on Bills & receivables, beside the invoices that came by email. A person adds every one: nothing is paid by itself."
    );
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/googledrive\/connect\?org=acme"[^>]*>[^]*?Connect Google Drive/);
    const other = card({ state: "not_connected" }, { canManage: false });
    expect(text(other)).toContain("An owner or admin can connect Google Drive.");
    expect(other).not.toContain("/integrations/googledrive/connect");
  });
});

describe("the folder (Google Drive intake GD4, GD5, GD13)", () => {
  it("asks an owner or admin for the folder's link before one is chosen, read for its ID, never opened (GD4)", () => {
    const markup = card(connected(null, { read30d: 0, waiting: 0, added30d: 0 }));
    const words = text(markup);
    expect(words).toContain("Connected to the Google Drive of du***@gmail.com");
    expect(words).toContain("Connected on Nov 1. Vestiarion reads only the folder chosen here, and writes nothing to the Drive.");
    expect(words).toContain(
      "No folder is chosen yet. Choose a new, empty folder, or one whose bills are already paid: the files in it when you choose it are never read, only the ones added afterwards."
    );
    expect(words).toContain("The folder's link from Google Drive");
    expect(markup).toMatch(/<input[^>]*name="folder"[^>]*>/);
    expect(markup).toMatch(/<label[^>]*for="([^"]+)"[^>]*>The folder's link from Google Drive<\/label>[^]*?<input[^>]*id="\1"/);
    expect(words).toContain("Paste the folder's link, or its ID. Vestiarion reads the folder through this connection, never by opening the link.");
    expect(buttons(markup)).toContain("Choose the folder");
    expect(markup).toContain('name="orgSlug" value="acme"');
    // Nothing to check until a folder is chosen (GD7).
    expect(buttons(markup)).not.toContain("Check Google Drive now");
  });

  it("tells anyone else who chooses the folder, without the form", () => {
    const markup = card(connected(null), { canManage: false });
    expect(text(markup)).toContain("No folder is chosen yet. An owner or admin chooses the folder Vestiarion reads.");
    expect(markup).not.toContain('name="folder"');
    expect(text(markup)).toContain("An owner or admin manages Google Drive.");
  });

  it("names the folder read, linked to Google Drive in a new tab, with the files left as they were and when it was last read (GD5, GD15)", () => {
    const markup = card(connected(FOLDER));
    const words = text(markup);
    expect(markup).toMatch(
      /<a[^>]*href="https:\/\/drive\.google\.com\/drive\/folders\/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Bills 2026<\/a>/
    );
    expect(words).toContain("Reading Bills 2026 in Google Drive");
    expect(words).toContain("Chosen on Nov 1 with 2 files in it, which are never read.");
    expect(words).toContain("Last read 6 minutes ago.");
    expect(buttons(markup)).toContain("Choose another folder");
    expect(text(card(connected({ ...FOLDER, baseline: 1 })))).toContain("Chosen on Nov 1 with 1 file in it, which is never read.");
    expect(text(card(connected({ ...FOLDER, baseline: 0 })))).toContain("Chosen on Nov 1, empty.");
    expect(text(card(connected({ ...FOLDER, lastRead: "Not read yet. Vestiarion reads it within 15 minutes." })))).toContain(
      "Not read yet. Vestiarion reads it within 15 minutes."
    );
  });

  it("wraps a long folder name with no place to break, and the answers that name it, so the card never scrolls sideways at 375 px", () => {
    const markup = card(connected({ ...FOLDER, name: "Pinecrest_Studio_Accounts_Payable_Invoices_2026" }));
    expect(markup).toMatch(/<p class="[^"]*\[overflow-wrap:anywhere\][^"]*">Reading <a[^>]*>Pinecrest_Studio_Accounts_Payable_Invoices_2026<\/a>/);
    // The choose form's answer and Check Google Drive now's answer.
    expect(markup.match(/<p role="status" aria-live="polite" class="[^"]*\[overflow-wrap:anywhere\][^"]*"/g)).toHaveLength(2);
  });

  it("says what stopped the last read, and asks for the folder again when it is gone (GD13)", () => {
    const gone = card(connected({ ...FOLDER, problem: "Google Drive no longer has this folder.", askAgain: true }));
    expect(gone).toMatch(/<p class="text-sm text-refused">Google Drive no longer has this folder\.<\/p>/);
    const slowed = card(connected({ ...FOLDER, problem: "Google asked Vestiarion to slow down.", askAgain: false }));
    expect(slowed).toMatch(/<p class="text-sm text-held">Google asked Vestiarion to slow down\.<\/p>/);
    expect(text(card(connected(FOLDER)))).not.toMatch(/no longer has|slow down/);
  });
});

describe("the figures and Check Google Drive now (Google Drive intake GD7, GD15)", () => {
  it("counts the files read and the bills added in 30 days, and links the files waiting to the review list", () => {
    const markup = card(connected(FOLDER));
    const words = text(markup);
    expect(words).toContain("Files read in the last 30 days 3 files");
    expect(words).toContain("Waiting for review 1 file");
    expect(words).toContain("Added as bills in the last 30 days 2 bills");
    expect(markup).toMatch(/<a[^>]*href="\/o\/acme\/invoices\?review=email"[^>]*>1 file<\/a>/);
    const none = card(connected(FOLDER, { read30d: 0, waiting: 0, added30d: 0 }));
    expect(text(none)).toContain("Waiting for review None");
    expect(none).not.toContain("review=email");
  });

  it("offers Check Google Drive now once a folder is chosen, to whoever adds invoices", () => {
    expect(buttons(card(connected(FOLDER)))).toContain("Check Google Drive now");
    expect(buttons(card(connected(FOLDER), { canCheck: false }))).not.toContain("Check Google Drive now");
    expect(buttons(card(connected(FOLDER), { canManage: false }))).toContain("Check Google Drive now");
  });
});

describe("connecting and disconnecting (Google Drive intake GD2, GD13)", () => {
  it("offers Disconnect Google Drive to an owner or admin while connected", () => {
    expect(buttons(card(connected(FOLDER)))).toContain("Disconnect Google Drive");
    expect(buttons(card(connected(FOLDER), { canManage: false }))).not.toContain("Disconnect Google Drive");
  });

  it("asks to reconnect in Google's words, with Reconnect Google Drive and Disconnect Google Drive for an owner or admin", () => {
    const markup = card({ state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS });
    expect(text(markup)).toContain("Google Drive needs you to reconnect");
    expect(text(markup)).toContain(RECONNECT_WORDS);
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/googledrive\/connect\?org=acme"[^>]*>[^]*?Reconnect Google Drive/);
    expect(buttons(markup)).toContain("Disconnect Google Drive");
    expect(buttons(markup)).not.toContain("Check Google Drive now");
    expect(card({ state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS }, { canManage: false })).not.toContain("/integrations/googledrive/connect");
  });

  it("says a disconnected Drive's files stay in the review list, and offers Connect Google Drive again", () => {
    const markup = card({ state: "revoked", account: "du***@gmail.com" });
    expect(text(markup)).toContain("Disconnected from du***@gmail.com");
    expect(text(markup)).toContain("Files already read stay in the review list on Bills & receivables. Nothing more is read from Google Drive.");
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/googledrive\/connect\?org=acme"[^>]*>[^]*?Connect Google Drive/);
    expect(buttons(markup)).not.toContain("Disconnect Google Drive");
  });

  it("says how connecting went, for every way back", () => {
    expect(GOOGLE_DRIVE_NOTICES).toEqual({
      connected: { tone: "success", text: "Google Drive is connected. Vestiarion reads only the folder chosen on this card." },
      cancelled: { tone: "error", text: "Connecting Google Drive was cancelled. Nothing changed." },
      forbidden: { tone: "error", text: "Only an owner or admin connects Google Drive, from their own browser." },
      other_organisation: { tone: "error", text: "This workspace is connected to another Google account. Disconnect it first, then connect the one you want." },
      scopes: { tone: "error", text: "Google did not give access to read your Drive files, so nothing was connected. Connect again and allow it." },
      not_set_up: { tone: "error", text: "Google Drive is not set up on this deployment yet." },
      failed: { tone: "error", text: "Google Drive did not finish connecting. Try again in a moment." },
    });
    for (const [code, notice] of Object.entries(GOOGLE_DRIVE_NOTICES)) {
      expect(text(card({ state: "not_connected" }, { notice: code }))).toContain(notice.text);
    }
    expect(text(card({ state: "not_connected" }, { notice: "made-up" }))).not.toMatch(/cancelled|did not finish/);
  });

  it("never shows a full email address", () => {
    for (const view of [
      connected(FOLDER),
      { state: "needs_reconnect", account: "du***@gmail.com", words: RECONNECT_WORDS },
      { state: "revoked", account: "du***@gmail.com" },
    ] as GoogleDrivePanelView[]) {
      expect(card(view)).not.toMatch(/[A-Za-z0-9._%+-]{3,}@gmail\.com/);
    }
  });
});
