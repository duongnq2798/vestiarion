import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), notFound: notFoundMock }));

import LinearStatePage from "@/app/docs-shots/linear/[state]/page";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * /docs-shots/linear/<state> (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN16), as Asana's: the
 * Linear card in Settings and a milestone's Linear card linking, ready, accepted and held, with sample data, only where
 * DOCS_SCREENSHOTS=1 is set.
 */

const render = async (state: string) => renderToStaticMarkup(<TooltipProvider>{await LinearStatePage({ params: Promise.resolve({ state }) })}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/docs-shots/linear/<state> (Linear acceptance LN16)", () => {
  it.each([[undefined], [""], ["0"]])("is not found when DOCS_SCREENSHOTS is %j", async (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    await expect(render("settings")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not found for a state it does not have", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    await expect(render("paid")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws the Settings card with the Linear workspace connected, its linked issues and the last 30 days' figures (LN15)", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const markup = await render("settings");
    const page = text(markup);
    expect(page).toContain("Connected to the Northstar workspace in Linear");
    expect(page).toContain("3 issues linked to milestones");
    expect(page).toContain("1 issue ready for acceptance");
    expect(page).toContain("1 issue held for review");
    expect(page).toContain("3 acceptances");
    expect(page).toContain("1 acceptance taken back");
    expect(page).toContain("2 minutes");
    expect(page).toContain("Check linked issues now");
    // No Linear logo yet: the product's icon for work tools.
    expect(markup).not.toContain("/brands/");
    expect(markup).toContain("lucide-square-kanban");
  });

  it("draws a milestone's card before an issue is linked, ready, accepted and held (LN4, LN7, LN8, LN10)", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const link = text(await render("link"));
    expect(link).toContain("Accept from Linear");
    expect(link).toContain("Link the issue");
    expect(link).toContain("Add the criteria");
    expect(link).not.toContain("Choose the task");
    const ready = text(await render("ready"));
    expect(ready).toContain("Ready for acceptance");
    expect(ready).toContain("Linear issue ENG-142:");
    expect(ready).toContain("Done in Linear on Oct 31, 2026 by Mai Tran.");
    expect(ready).toContain("Retry failed webhook deliveries with backoff #318");
    expect(ready).toContain("I checked each criterion against these deliverables, as shown here.");
    expect(ready).toContain("Accept the work");
    const accepted = text(await render("accepted"));
    expect(accepted).toContain("Accepted on Oct 31, 2026 by adam@northstar.example.");
    expect(accepted).toContain("Deliverables accepted");
    expect(accepted).not.toContain("Accept the work");
    const held = text(await render("held"));
    expect(held).toContain("Held for review");
    expect(held).toContain("The issue was reopened in Linear after the work was accepted");
    expect(held).toContain("In Progress in Linear: not done yet.");
  });
});
