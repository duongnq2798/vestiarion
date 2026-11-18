import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WaitingHeading } from "@/components/approvals/WaitingHeading";

/**
 * What an axe pass over Bills and Approvals found (maintenance U5, Nov 18): ink-3 labels on the raised tone, at
 * 4.29:1, and headings that jumped from the page's h1 to h3. The guide shots of both pages read 0 violations at 1280
 * and 375 after it; these hold the fixes in the source.
 */
const source = (...parts: string[]) => readFileSync(path.join(process.cwd(), "src", ...parts), "utf8");

describe("text on the raised tone in an approval card", () => {
  it("the cost lines are ink-2 at the quietest", () => {
    const card = source("components", "ApprovalCard.tsx");
    const breakdown = card.slice(card.indexOf("function CostBreakdown"), card.indexOf("\n}\n", card.indexOf("function CostBreakdown")));
    expect(breakdown).toContain("bg-raised");
    expect(breakdown).not.toContain("text-ink-3");
  });

  it("what a vendor sent with a document is labelled in ink-2", () => {
    const line = source("components", "document-requests", "DocumentRequestLine.tsx");
    expect(line).toContain("bg-raised");
    expect(line).toContain('<dt className="text-ink-2">Purchase order they typed</dt>');
    expect(line).toContain('<dt className="text-ink-2">Their note</dt>');
    expect(line).not.toContain("text-ink-3");
  });
});

describe("heading levels", () => {
  it("Approvals gives its waiting list an h2 before the cards and the empty state", () => {
    expect(renderToStaticMarkup(<WaitingHeading />)).toBe('<h2 class="sr-only">Waiting for a decision</h2>');
    const page = source("app", "o", "[slug]", "approvals", "page.tsx");
    expect(page.indexOf("<WaitingHeading />")).toBeGreaterThan(0);
    expect(page.indexOf("<WaitingHeading />")).toBeLessThan(page.indexOf("<ApprovalSelection"));
  });

  it("the guide shots of Approvals have the same h2", () => {
    for (const shot of [["[shot]"], ["deal-cash", "[state]"], ["onboarding", "[state]"], ["projects", "[state]"]]) {
      expect(source("app", "docs-shots", ...shot, "page.tsx"), shot.join("/")).toContain("<WaitingHeading />");
    }
  });

  it("an empty Bills or Receivables list is titled h2, right under the page's h1", () => {
    const list = source("components", "bills", "BillsList.tsx");
    const empties = list.match(/<EmptyState\b[^>]*>/g) ?? [];
    expect(empties.length).toBeGreaterThan(0);
    for (const empty of empties) expect(empty).toContain('titleAs="h2"');
  });
});
