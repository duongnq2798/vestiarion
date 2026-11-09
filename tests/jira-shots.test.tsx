import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), notFound: notFoundMock }));

import JiraStatePage from "@/app/docs-shots/jira/[state]/page";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * /docs-shots/jira/<state> (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR22), as Linear's: the Jira card
 * in Settings and a milestone's Jira card linking, ready, accepted and held, with sample data, only where
 * DOCS_SCREENSHOTS=1 is set.
 */

const render = async (state: string) => renderToStaticMarkup(<TooltipProvider>{await JiraStatePage({ params: Promise.resolve({ state }) })}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/docs-shots/jira/<state> (Jira acceptance JR22)", () => {
  it.each([[undefined], [""], ["0"]])("is not found when DOCS_SCREENSHOTS is %j", async (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    await expect(render("settings")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not found for a state it does not have", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    await expect(render("paid")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws the Settings card with the Jira site connected, its notices, its linked issues and the last 30 days' figures (JR21)", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const markup = await render("settings");
    const page = text(markup);
    expect(markup).toContain('data-jira-state="settings"');
    expect(page).toContain("Connected to the Northstar site in Jira");
    expect(page).toContain("Site: northstar.atlassian.net");
    expect(page).toContain("Jira last told Vestiarion of a change Nov 9, 2026, 10:20 UTC.");
    expect(page).toContain("3 issues linked to milestones");
    expect(page).toContain("1 issue ready for acceptance");
    expect(page).toContain("1 issue held for review");
    expect(page).toContain("3 acceptances");
    expect(page).toContain("1 acceptance taken back");
    expect(page).toContain("2 minutes");
    expect(page).toContain("Check linked issues now");
    // No Atlassian logo: the product's icon for work tools.
    expect(markup).not.toContain("/brands/");
    expect(markup).toContain("lucide-square-kanban");
  });

  it("draws a milestone's card before an issue is linked, ready, accepted and held (JR6, JR7, JR11, JR13)", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const link = text(await render("link"));
    expect(link).toContain("Accept from Jira");
    expect(link).toContain("Link the issue");
    expect(link).toContain("Add the criteria");
    const ready = text(await render("ready"));
    expect(ready).toContain("Ready for acceptance");
    expect(ready).toContain("Jira issue ENG-142:");
    expect(ready).toContain("Done in Jira on Nov 9, 2026 (Done, resolved as Done).");
    expect(ready).toContain("On northstar.atlassian.net.");
    expect(ready).toContain("Retry failed webhook deliveries with backoff #318");
    expect(ready).toContain("I checked each criterion against these deliverables, as shown here.");
    expect(ready).toContain("Accept the work");
    const accepted = text(await render("accepted"));
    expect(accepted).toContain("Accepted on Nov 9, 2026 by adam@northstar.example.");
    expect(accepted).toContain("Deliverables accepted");
    expect(accepted).not.toContain("Accept the work");
    const held = text(await render("held"));
    expect(held).toContain("Held for review");
    expect(held).toContain("The issue was reopened in Jira after the work was accepted");
    expect(held).toContain("In Progress in Jira: not done yet.");
    // The sample's people are named by email only once they accepted, never Jira's own names (JR22).
    expect(ready).not.toContain("@");
  });
});
