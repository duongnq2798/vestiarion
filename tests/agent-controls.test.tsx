import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AgentControlsClient from "@/components/AgentControlsClient";

/**
 * The page head's agent actions, as the markup they render on the server. The
 * router and the server action are stand-ins: nothing here runs a cycle.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/actions/agent", () => ({ runAgentCycleAction: vi.fn() }));

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("AgentControlsClient", () => {
  it("puts the page's own action and Run in one row", () => {
    const markup = html(<AgentControlsClient orgSlug="acme" nextDay={4} clockMode="simulate" leading={<span>Pause agent</span>} />);
    expect(markup).toMatch(/<div class="[^"]*flex-wrap[^"]*"><span>Pause agent<\/span><button[^>]*>(?:(?!<\/button>).)*Run day 4<\/button><\/div>/);
  });

  it("keeps the status line narrower than the page head, beneath the row", () => {
    const markup = html(<AgentControlsClient orgSlug="acme" nextDay={4} clockMode="simulate" />);
    expect(markup).toMatch(/<\/div><p aria-live="polite" class="[^"]*max-w-sm/);
  });

  it("keeps Run while paused, disabled, and says why", () => {
    const markup = html(<AgentControlsClient orgSlug="acme" nextDay={4} clockMode="simulate" paused />);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Run day 4<\/button>/);
    expect(markup).toContain("The agent is paused. Resume it to run a cycle.");
  });

  it("names a wall-clock run a cycle", () => {
    expect(html(<AgentControlsClient orgSlug="acme" nextDay={4} clockMode="real" />)).toContain("Run cycle now");
  });
});
