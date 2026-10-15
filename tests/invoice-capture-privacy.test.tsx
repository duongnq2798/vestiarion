import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_MS } from "@/lib/extension/tokens";
import { MAX_CAPTURED_CHARS, RAW_TEXT_DAYS, UNSENT_DRAFT_DAYS } from "@/lib/invoice-drafts/model";
import { MAX_DOCUMENT_BYTES } from "@/lib/invoice-document/read";

/**
 * The privacy page's Chrome extension section (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C9-C11,
 * C25): what the extension captures and when, where it goes, what is kept and for how long, the tokens, and no
 * analytics, each as the code does it. The numbers are read from the code and the migration.
 */

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("the privacy page's Chrome extension section", () => {
  const markup = renderToStaticMarkup(<PrivacyPage />);
  const section = text(markup.split('id="chrome-extension"')[1]?.split('id="retention"')[0] ?? "");

  it("says when a page is read, what is sent and to whom", () => {
    for (const phrase of [
      "only when you press Capture selected text , or choose Capture invoice with Vestiarion on a selection",
      `at most ${MAX_CAPTURED_CHARS.toLocaleString("en-US")} characters`,
      `of at most ${MAX_DOCUMENT_BYTES / 1_000_000} MB`,
      "never reads your browsing history",
      "goes only to Vestiarion, at www.vestiarion.xyz",
      "a picture is not read",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it("says what is kept, and for how long, as the sweep keeps it", () => {
    expect(section).toContain("A file itself is never kept");
    expect(section).toContain(`${RAW_TEXT_DAYS} days after capture at the latest`);
    expect(section).toContain(`deleted after ${UNSENT_DRAFT_DAYS} days`);
    const migration = source("supabase/migrations/0121_invoice_capture.sql");
    expect(migration).toContain(`captured_at < p_now - interval '${RAW_TEXT_DAYS} days'`);
    expect(migration).toContain(`state = 'draft' and captured_at < p_now - interval '${UNSENT_DRAFT_DAYS} days'`);
    // The text goes with the decision too.
    const commands = source("src/lib/commands/invoice-drafts.ts");
    expect(commands.split("export async function confirmInvoiceDraft")[1]).toContain("raw_text: null");
    expect(commands.split("export async function discardInvoiceDraft")[1]).toContain("raw_text: null");
    const retention = text(markup.split('id="retention"')[1]?.split('id="delete-workspace"')[0] ?? "");
    expect(retention).toContain("Text captured with the Chrome extension is removed when its draft is added or discarded");
  });

  it("says how the tokens are kept and ended, as the code issues them", () => {
    expect(ACCESS_TTL_SECONDS).toBe(3600);
    expect(section).toContain("access token (an hour)");
    expect(REFRESH_TTL_MS).toBe(30 * 86_400_000);
    expect(section).toContain("refresh token (30 days)");
    expect(section).toContain("Vestiarion keeps only their SHA-256");
    expect(section).toContain("leaving the workspace deletes them");
  });

  it("says there are no analytics on what is captured", () => {
    expect(section).toContain("The extension has no analytics. Nothing about an invoice you capture is sent to an analytics service");
  });
});
