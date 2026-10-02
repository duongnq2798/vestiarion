import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ScreeningMatch from "@/components/intake/ScreeningMatch";
import { TooltipProvider } from "@/components/ui/Tooltip";

vi.mock("@/app/actions/compliance", () => ({ dismissScreeningMatchAction: vi.fn(), screenAgainAction: vi.fn() }));

/**
 * A counterparty's screening match on its card (dismiss screening match §2): the match and what it
 * does to the limit for a medium or high verdict, and Not this person only for a live match the viewer
 * may dismiss (R1, R6).
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

const MATCHED = { id: "cp-1", name: "Quoc Duong", riskLevel: "medium", riskNotes: "Dương Trung Quốc matched at 0.909 (role.pep, role.pol)", riskEntityId: "Q-PEP" };

describe("ScreeningMatch", () => {
  it("shows a medium match, what it does to the limit, and Not this person", () => {
    const page = text(render(<ScreeningMatch orgSlug="studio" counterparty={MATCHED} canDismiss />));
    expect(page).toContain("Screening match: Dương Trung Quốc matched at 0.909 (role.pep, role.pol)");
    expect(page).toContain("at most a quarter of its limit");
    expect(page).toContain("Not this person");
  });

  it("says a high match pays nothing", () => {
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={{ ...MATCHED, riskLevel: "high" }} canDismiss />))).toContain("pays it nothing");
  });

  it("offers no dismissal to a member who cannot decide approvals, or for a match with no entity", () => {
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={MATCHED} canDismiss={false} />))).not.toContain("Not this person");
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={{ ...MATCHED, riskEntityId: null }} canDismiss />))).not.toContain("Not this person");
  });

  it("offers Screen again for a live match recorded before verdicts kept the entity they matched", () => {
    const old = { ...MATCHED, riskEntityId: null };
    const page = text(render(<ScreeningMatch orgSlug="studio" counterparty={old} canDismiss liveScreening />));
    expect(page).toContain("This match was recorded before Vestiarion kept who it matched.");
    expect(page).toContain("Screen again");
    expect(page).not.toContain("Not this person");
    // Not for a bundled match, which never names one, nor for a member who cannot dismiss, nor once it names one.
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={old} canDismiss />))).not.toContain("Screen again");
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={old} canDismiss={false} liveScreening />))).not.toContain("Screen again");
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={MATCHED} canDismiss liveScreening />))).not.toContain("Screen again");
  });

  it("shows nothing for a clear counterparty", () => {
    expect(render(<ScreeningMatch orgSlug="studio" counterparty={{ ...MATCHED, riskLevel: "clear" }} canDismiss />)).toBe("");
  });
});
