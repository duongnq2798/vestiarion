import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/sample-data", () => ({
  loadSampleDataAction: vi.fn(),
  removeSampleDataAction: vi.fn(),
}));

import { SampleDataLoaded, SampleDataOffer } from "@/components/SampleDataPanel";
import { offerSampleData } from "@/lib/sample-data-offer";

/** The console's sample-data card and callout, as the markup they render on the server, and how the pages wire them. */

describe("offerSampleData", () => {
  const base = { canWrite: true, mode: "sandbox" as const, chainMode: "simulate" as const, counterpartyCount: 0 };

  it("offers the sample to someone who adds records, in an empty simulated sandbox", () => {
    expect(offerSampleData(base)).toBe(true);
  });

  it.each([
    [{ canWrite: false }],
    [{ mode: "live" as const }],
    // A sandbox that connected Circle or chose a hosted wallet pays for real (S1).
    [{ chainMode: "live" as const }],
    [{ counterpartyCount: 1 }],
  ])("does not offer it when %j", (change) => {
    expect(offerSampleData({ ...base, ...change })).toBe(false);
  });
});

describe("SampleDataOffer", () => {
  it("names the sample and the button, and posts the workspace", () => {
    const markup = renderToStaticMarkup(<SampleDataOffer orgSlug="acme" />);
    expect(markup).toContain("Try it with sample data");
    expect(markup).toContain("Load sample data");
    expect(markup).toContain('name="orgSlug" value="acme"');
  });
});

describe("SampleDataLoaded", () => {
  it("says the sample is loaded and offers removal to someone who adds records", () => {
    const markup = renderToStaticMarkup(<SampleDataLoaded orgSlug="acme" canRemove />);
    expect(markup).toContain("Sample data is loaded");
    expect(markup).toContain("Remove sample data");
  });

  it("shows no control to someone who cannot remove it", () => {
    const markup = renderToStaticMarkup(<SampleDataLoaded orgSlug="acme" canRemove={false} />);
    expect(markup).toContain("Sample data is loaded");
    expect(markup).not.toContain("Remove sample data");
    expect(markup).not.toContain("<form");
  });
});

describe("the pages", () => {
  const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", ...parts), "utf8");

  it("the console offers the sample from rows it already reads", () => {
    const page = read("console", "page.tsx");
    expect(page).toContain(
      "offerSampleData({ canWrite: can(role, \"records.write\"), mode: access.membership.mode, chainMode: modes.mode, counterpartyCount: counterparties.length })"
    );
    expect(page).toContain("counterparties.some((counterparty) => counterparty.sample)");
  });

  it("the counterparty book marks sample counterparties", () => {
    // Each row of the book is a CounterpartyRow, which draws the badge.
    expect(read("counterparties", "page.tsx")).toContain("<CounterpartyRow counterparty={counterparty} network={network}>");
    expect(readFileSync(path.join(process.cwd(), "src", "components", "CounterpartyRow.tsx"), "utf8")).toMatch(/counterparty\.sample && <Badge[^>]*>Sample<\/Badge>/);
  });
});
