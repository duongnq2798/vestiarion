import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), notFound: notFoundMock }));

import AsanaStatePage from "@/app/docs-shots/asana/[state]/page";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * /docs-shots/asana/<state> (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md, Screens): the Asana card in
 * Settings and a milestone's Asana card linking, ready, accepted and held, with sample data, only where
 * DOCS_SCREENSHOTS=1 is set.
 */

const render = async (state: string) => renderToStaticMarkup(<TooltipProvider>{await AsanaStatePage({ params: Promise.resolve({ state }) })}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/docs-shots/asana/<state>", () => {
  it.each([[undefined], [""], ["0"]])("is not found when DOCS_SCREENSHOTS is %j", async (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    await expect(render("settings")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not found for a state it does not have", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    await expect(render("paid")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws the Settings card with its status, its linked tasks and the last 30 days' figures", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const page = text(await render("settings"));
    expect(page).toContain("Connected to Olivia's Asana");
    expect(page).toContain("3 tasks linked to milestones");
    expect(page).toContain("1 task ready for acceptance");
    expect(page).toContain("1 task held for review");
    expect(page).toContain("3 acceptances");
    expect(page).toContain("1 acceptance taken back");
    expect(page).toContain("2 minutes");
    expect(page).toContain("Check linked tasks now");
  });

  it("draws a milestone's card before a task is linked, ready, accepted and held", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const link = text(await render("link"));
    expect(link).toContain("Accept from Asana");
    expect(link).toContain("Link the task");
    expect(link).toContain("Choose the task in Asana instead");
    const ready = text(await render("ready"));
    expect(ready).toContain("Ready for acceptance");
    expect(ready).toContain("Completed in Asana on Oct 14, 2026 by Mai Tran.");
    expect(ready).toContain("fernhill-logo-motion.mp4");
    expect(ready).toContain("I checked each criterion against these deliverables, as shown here.");
    expect(ready).toContain("Accept the work");
    const accepted = text(await render("accepted"));
    expect(accepted).toContain("Accepted on Oct 14, 2026 by adam@northstar.example.");
    expect(accepted).toContain("Deliverables accepted");
    expect(accepted).not.toContain("Accept the work");
    const held = text(await render("held"));
    expect(held).toContain("Held for review");
    expect(held).toContain("The task was reopened in Asana after the work was accepted");
    expect(held).toContain("Not completed in Asana.");
  });
});
