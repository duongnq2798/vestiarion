// tests/audit-export-ui.test.tsx
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuditExportMenu } from "@/components/AuditExportMenu";

describe("AuditExportMenu", () => {
  const markup = renderToStaticMarkup(<AuditExportMenu orgSlug="north-star" />);

  it("offers the signed JSON and the CSV as downloads of this workspace's ledger", () => {
    expect(markup).toContain("Download");
    expect(markup).toContain("Signed JSON");
    expect(markup).toContain("CSV");
    expect(markup).toContain('href="/api/ledger/export?org=north-star&amp;format=json"');
    expect(markup).toContain('href="/api/ledger/export?org=north-star&amp;format=csv"');
    expect(markup.match(/ download=""/g)).toHaveLength(2);
  });

  it("points at the guide for checking the file", () => {
    expect(markup).toContain('href="/docs/guides/audit-export"');
  });

  it("labels the download links for assistive tech with a programmatic group label", () => {
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-labelledby="audit-export-label"');
    const labelMatch = markup.match(/<span id="audit-export-label"[^>]*>(.*?)<\/span>/);
    expect(labelMatch).not.toBeNull();
    expect(labelMatch![1]).toContain("Download");
  });
});

describe("the Audit page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "audit", "page.tsx"), "utf8");

  it("renders the control for every member, with no role check", () => {
    expect(page).toContain("<AuditExportMenu orgSlug={slug} />");
    expect(page).not.toMatch(/can\([^)]*\)\s*&&\s*<AuditExportMenu/);
  });

  it("says what the key id and head hash are for", () => {
    expect(page).toContain("Compare this key id and the head hash with the ones a verified export prints.");
  });

  it("lists retired keys with exportKeys, only when there are some", () => {
    expect(page).toMatch(/import\s*\{[^}]*\bexportKeys\b[^}]*\}\s*from\s*"@\/lib\/ledger-export"/);
    expect(page).toContain("retiredKeys.length > 0");
    expect(page).toMatch(/retiredKeys\.length > 0 &&[\s\S]*?Retired keys/);
  });

  it("lists retired keys whether or not the active key is readable, so the summary's count always matches what expands", () => {
    // After the readable-key / no-readable-key branches, not inside either.
    const noKey = page.indexOf("it is unverified, which is a different");
    const list = page.indexOf("retiredKeys.length > 0 &&");
    expect(noKey).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(noKey);
    // The no-readable-key branch has closed before the list opens.
    expect(page.slice(noKey, list)).toMatch(/<\/p>\s*\)\}/);
  });
});
