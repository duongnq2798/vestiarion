// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClosePack } from "@/lib/close-pack/types";
import type { ClosePackSheetsView } from "@/lib/googlesheets/views";

/**
 * Export to Google Sheets on the close pack page (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS5, GS9): the export's answer and its link live in the control, which the page places outside what the pack's read
 * renders, so a render whose read was refused (the page's reads spent) keeps them. A done export also stands for the
 * month's last export, so the page's older "Last exported" line gives way to it until the page is read again.
 */

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit";
const OLD_URL = "https://docs.google.com/spreadsheets/d/1Vx0000000000000000000000000000000000000old/edit";
const actions = vi.hoisted(() => ({ exportClosePackToSheetsAction: vi.fn(), disconnectGoogleSheetsAction: vi.fn() }));
vi.mock("@/app/actions/googlesheets", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/o/pinecrest-studio/evidence/close-pack" }));

import { ClosePackView } from "@/components/ClosePackView";
import { SheetsExport } from "@/components/close-pack/SheetsExport";
import { samplePack } from "./support/close-pack-fixtures";

const PACK = samplePack();
const READY: ClosePackSheetsView = { state: "ready", account: "du***@gmail.com", canExport: true, last: { at: "2026-10-20 09:00 UTC", payments: 2, url: OLD_URL } };
const REFUSED = "The close pack was read many times in a row. Try again in a minute.";

let container: HTMLDivElement;
let root: Root;

/** The page's body, as the page renders it: the control made from the month and the workspace, never from the pack. */
const show = (pack: ClosePack | null, view: ClosePackSheetsView = READY) =>
  act(() =>
    root.render(
      <ClosePackView pack={pack} sheets={<SheetsExport orgSlug={PACK.workspace.slug} month={PACK.month.key} view={view} />} refused={<p>{REFUSED}</p>} />
    )
  );

beforeEach(() => {
  actions.exportClosePackToSheetsAction.mockResolvedValue({ ok: true, message: "Exported 3 payments to Google Sheets.", sheet: { url: SHEET_URL, account: "du***@gmail.com" } });
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

const links = () => [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));

describe("Export to Google Sheets, once it answers (close pack Sheets GS5, GS9)", () => {
  it("keeps the answer and its link when the page renders again without the pack", async () => {
    show(PACK);
    await press("Export to Google Sheets");
    expect(actions.exportClosePackToSheetsAction).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Exported 3 payments to Google Sheets.");

    // The page's reads are spent: no pack, the refusal in its place, and the export's answer still there.
    show(null);
    expect(container.textContent).toContain(REFUSED);
    expect(container.textContent).not.toContain("Download CSV");
    expect(container.textContent).toContain("Exported 3 payments to Google Sheets.");
    expect(links()).toContain(SHEET_URL);
  });

  it("shows the done export in place of the page's older Last exported line", async () => {
    show(PACK);
    expect(container.textContent).toContain("Last exported to Google Sheets on 2026-10-20 09:00 UTC: 2 payments.");
    expect(links()).toContain(OLD_URL);
    await press("Export to Google Sheets");
    expect(container.textContent).not.toContain("Last exported to Google Sheets on 2026-10-20 09:00 UTC");
    expect(links()).not.toContain(OLD_URL);
    expect(links()).toContain(SHEET_URL);
  });

  it("keeps the older Last exported line when the export did not finish", async () => {
    actions.exportClosePackToSheetsAction.mockResolvedValue({ ok: false, message: "Google did not answer. Try again in a moment." });
    show(PACK);
    await press("Export to Google Sheets");
    expect(container.textContent).toContain("Google did not answer. Try again in a moment.");
    expect(container.textContent).toContain("Last exported to Google Sheets on 2026-10-20 09:00 UTC: 2 payments.");
  });
});
