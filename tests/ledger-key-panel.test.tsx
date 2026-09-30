import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import LedgerKeyPanel, { type LedgerKeyPanelProps } from "@/components/LedgerKeyPanel";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * The "Ledger signing key" section of Settings, as server-rendered markup
 * (the `tests/go-live-panel.test.tsx` shape). Its confirmation dialog opens
 * in a portal, which a static render leaves closed (the `delete-workspace-
 * panel.test.tsx` note), so the dialog's own strings are checked against the
 * component's source instead, as `tests/audit-export-ui.test.tsx` does for
 * page source.
 */

vi.mock("@/app/actions/ledger-key", () => ({ rotateLedgerKeyAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();

function status(overrides: Partial<LedgerKeyPanelProps["status"]> = {}): LedgerKeyPanelProps["status"] {
  return { current: "key-current", retired: [], ...overrides };
}

const panel = (overrides: Partial<LedgerKeyPanelProps["status"]> = {}, canAdminister = true) =>
  html(<LedgerKeyPanel orgSlug="northstar" status={status(overrides)} canAdminister={canAdminister} />);

describe("LedgerKeyPanel", () => {
  it("is a section titled Ledger signing key", () => {
    const markup = panel();
    expect(markup).toMatch(/<section[^>]*aria-labelledby="ledger-key-title"/);
    expect(markup).toMatch(/<h2 id="ledger-key-title"[^>]*>Ledger signing key<\/h2>/);
  });

  it("shows the current key's id in mono", () => {
    const markup = panel({ current: "vxlk_abc123" });
    expect(text(markup)).toContain("Current key");
    expect(markup).toMatch(/<p class="[^"]*font-mono[^"]*">vxlk_abc123<\/p>/);
  });

  it("shows an em dash when there is no readable current key", () => {
    const markup = panel({ current: null });
    expect(markup).toMatch(/<p class="[^"]*font-mono[^"]*">—<\/p>/);
  });

  it("says no key has been retired yet when there are none", () => {
    expect(text(panel({ retired: [] }))).toContain("No key has been retired yet.");
  });

  it("lists each retired key's id and when it was retired, formatted to the minute in UTC", () => {
    const markup = panel({
      retired: [
        { id: "vxlk_old1", retiredAt: "2026-09-30T05:07:00.000Z" },
        { id: "vxlk_old2", retiredAt: "2026-08-01T12:30:00.000Z" },
      ],
    });
    const words = text(markup);
    expect(words).toContain("vxlk_old1 · retired Sep 30, 2026, 05:07 UTC");
    expect(words).toContain("vxlk_old2 · retired Aug 1, 2026, 12:30 UTC");
    expect(words).not.toContain("No key has been retired yet.");
  });

  it("for an owner, offers a Rotate signing key button and no note", () => {
    const markup = panel();
    expect(markup).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*?Rotate signing key/);
    expect(text(markup)).not.toContain("An owner of this workspace can rotate the key.");
    expect(markup).toMatch(/<input type="hidden" name="orgSlug" value="northstar"\/>/);
  });

  it("for anyone else, shows the note instead of a button", () => {
    const markup = panel({}, false);
    expect(text(markup)).toContain("An owner of this workspace can rotate the key.");
    expect(markup).not.toContain("Rotate signing key");
    expect(markup).not.toContain("<form");
  });
});

describe("LedgerKeyPanel's confirmation (rendered in a portal, so checked in source)", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "components", "LedgerKeyPanel.tsx"), "utf8");

  it("asks with the exact title, description and confirm label, tone danger", () => {
    expect(source).toContain('tone="danger"');
    expect(source).toContain('title="Rotate the ledger signing key?"');
    expect(source).toContain(
      "New entries are signed by a new key. Entries already written keep verifying with the old public key, which stays listed here. The old private key is discarded and cannot sign again."
    );
    expect(source).toContain('confirmLabel="Rotate key"');
  });
});
