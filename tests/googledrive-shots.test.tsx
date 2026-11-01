import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), notFound: notFoundMock }));

import GoogleDriveStatePage from "@/app/docs-shots/googledrive/[state]/page";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * /docs-shots/googledrive/<state> (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md, Screens), as
 * Linear's: the Google Drive card in Settings connected with its folder and figures, the same card asking for the
 * folder's link, and the review list on Bills & receivables with a file from the folder beside an emailed invoice, with
 * sample data, only where DOCS_SCREENSHOTS=1 is set.
 */

const render = async (state: string) => renderToStaticMarkup(<TooltipProvider>{await GoogleDriveStatePage({ params: Promise.resolve({ state }) })}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/docs-shots/googledrive/<state> (Google Drive intake GD16)", () => {
  it.each([[undefined], [""], ["0"]])("is not found when DOCS_SCREENSHOTS is %j", async (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    await expect(render("settings")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not found for a state it does not have", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    await expect(render("paid")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws the Settings card connected, with its folder, its figures and Check Google Drive now (GD15)", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const markup = await render("settings");
    const page = text(markup);
    expect(page).toContain("Connected to the Google Drive of ow***@pinecrest.test");
    expect(page).toContain("Reading Bills 2026 in Google Drive");
    expect(page).toContain("Chosen on Nov 1 with 2 files in it, which are never read.");
    expect(page).toContain("Last read 6 minutes ago.");
    expect(page).toContain("Files read in the last 30 days 3 files");
    expect(page).toContain("Check Google Drive now");
    expect(page).toContain("Choose another folder");
    // No Google mark: a plain folder icon (GD1).
    expect(markup).not.toContain("/brands/");
    expect(markup).toContain("lucide-folder");
  });

  it("draws the card before a folder is chosen, asking for its link (GD4)", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const page = text(await render("folder"));
    expect(page).toContain("No folder is chosen yet.");
    expect(page).toContain("The folder's link from Google Drive");
    expect(page).toContain("Choose the folder");
    expect(page).not.toContain("Check Google Drive now");
  });

  it("draws the review list with a file from the folder ready to add beside an emailed invoice (GD8)", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const page = text(await render("review"));
    expect(page).toContain("From email and Google Drive");
    expect(page).toContain("Coastal Flour Mill - INV-3318.pdf");
    expect(page).toContain("From Google Drive · found Nov 1, 10:24 UTC");
    expect(page).toContain("Last changed in Google Drive by bo***@pinecrest.test.");
    expect(page).toContain("Invoice INV-2207");
    expect(page).toContain("Check Google Drive now");
    expect(page.match(/Add, goods received/g)?.length).toBe(2);
  });
});
