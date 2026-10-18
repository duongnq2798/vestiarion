import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The landing page streams (landing stream S1): nothing above the proof waits for a read, so the hero and the sections
 * before the proof are in the first HTML even while every read of production is still pending, and the proof shows its
 * fallbacks instead of its figures.
 */

const pending = <T,>() => new Promise<T>(() => {});

const reads = vi.hoisted(() => ({
  readAllTimeOrNull: vi.fn(),
  readLatestDecision: vi.fn(),
  reserveRunsLive: vi.fn(),
  withFoundingOrg: vi.fn(),
}));

vi.mock("@/lib/platform/open-numbers", async (original) => ({ ...(await original<object>()), readAllTimeOrNull: reads.readAllTimeOrNull }));
vi.mock("@/lib/platform/latest-decision", async (original) => ({ ...(await original<object>()), readLatestDecision: reads.readLatestDecision }));
vi.mock("@/lib/platform/usyc-reserve", async (original) => ({ ...(await original<object>()), reserveRunsLive: reads.reserveRunsLive }));
vi.mock("@/lib/dal/scope", async (original) => ({ ...(await original<object>()), withFoundingOrg: reads.withFoundingOrg }));
vi.mock("@/lib/context", async (original) => ({ ...(await original<object>()), currentConfig: () => ({ mainnetEnabled: true, mainnetAllowlist: ["*"] }) }));

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the landing page, while every read is pending", () => {
  // The page imports most of the app on first load; the first import takes a while.
  beforeAll(async () => {
    await import("@/app/page");
  }, 60_000);

  beforeEach(() => {
    reads.readAllTimeOrNull.mockImplementation(() => pending());
    reads.readLatestDecision.mockImplementation(() => pending());
    reads.reserveRunsLive.mockImplementation(() => pending());
    reads.withFoundingOrg.mockImplementation(() => pending());
  });

  it("renders without awaiting anything, and starts every read", async () => {
    const { default: LandingPage } = await import("@/app/page");
    const page = LandingPage();
    expect(page).not.toBeInstanceOf(Promise);
    expect(reads.readAllTimeOrNull).toHaveBeenCalledWith("arc-mainnet");
    expect(reads.readAllTimeOrNull).toHaveBeenCalledWith("arc-testnet");
  });

  it("has the hero and every section before the proof in its first HTML, and the proof's fallbacks", async () => {
    const { default: LandingPage } = await import("@/app/page");
    // The root layout provides the tooltip provider the page's terminal uses.
    const words = text(renderToStaticMarkup(<TooltipProvider>{LandingPage()}</TooltipProvider>));
    for (const part of [
      "Every bill checked before it's paid. Every decision on record.",
      "Try it on your bills",
      "Evaluate first. Turn on payments later.",
      "For small businesses that pay people for their work.",
      "The AI suggests. Your rules decide.",
      "Don't take our word for it.",
      "Loading the agent's latest decision",
      "Loading customer activity",
      "A real payment, with a verifiable trail.",
      "Everything you need to know.",
      "See what the agent decides on your next bill.",
    ]) {
      expect(words).toContain(part);
    }
  });
});
