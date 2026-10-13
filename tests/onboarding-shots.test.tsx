import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), notFound: notFoundMock }));

import OnboardingStatePage from "@/app/docs-shots/onboarding/[state]/page";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * /docs-shots/onboarding/<state> (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md,
 * Screenshots): the three role checklists and an evidence link that can't be opened, with sample data, only where
 * DOCS_SCREENSHOTS=1 is set.
 */

// Inside the root layout's tooltip provider, as every page is.
const render = async (state: string) => renderToStaticMarkup(<TooltipProvider>{await OnboardingStatePage({ params: Promise.resolve({ state }) })}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/docs-shots/onboarding/<state>", () => {
  it.each([[undefined], [""], ["0"]])("is not found when DOCS_SCREENSHOTS is %j", async (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    await expect(render("owner")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not found for a state it does not have", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    await expect(render("viewer")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws each role's checklist where it lands, with the app's own components", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const owner = text(await render("owner"));
    expect(owner).toContain("Set or confirm the limits");
    expect(owner).toContain("Keep these limits");
    expect(owner).toContain("Don't show again");
    expect(owner).toContain("Agent spending limit");
    const approver = text(await render("approver"));
    expect(approver).toContain("Get started as an approver");
    expect(approver).toContain("Decide it, or send it back");
    const accountant = text(await render("accountant"));
    expect(accountant).toContain("Get started as an accountant");
    expect(accountant).toContain("Accountant console");
  });

  it("draws a pull request that can't be opened, never as a link, and a link not checked", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    const markup = await render("evidence");
    expect(markup).not.toContain('href="https://github.com/northstar-studio/brand-site/pull/58"');
    expect(text(markup)).toContain("Can't be opened: It is in a private repository on GitHub");
    expect(text(markup)).toContain("merged PR, can't be opened");
    expect(text(markup)).toContain("drive.example.test, not checked");
  });
});
