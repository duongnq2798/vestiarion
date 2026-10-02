import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ScreeningMatch, { DismissForm } from "@/components/intake/ScreeningMatch";
import { Dialog } from "@/components/ui/Dialog";
import { TooltipProvider } from "@/components/ui/Tooltip";

vi.mock("@/app/actions/compliance", () => ({ dismissScreeningMatchAction: vi.fn(), screenAgainAction: vi.fn() }));

/**
 * A counterparty's screening match on its card (dismiss screening match §2): the match and what it
 * does to the limit for a medium or high verdict, and Not this person only for a live match the viewer
 * may dismiss (R1, R6).
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

const PEP = { id: "Q-PEP", caption: "Dương Trung Quốc", score: 0.909, topics: ["role.pep", "role.pol"] };
const MATCHED = {
  id: "cp-1",
  name: "Quoc Duong",
  riskLevel: "medium",
  riskNotes: "Dương Trung Quốc matched at 0.909 (role.pep, role.pol)",
  riskEntityId: "Q-PEP",
  matches: [PEP],
};
const SEVERAL = [
  PEP,
  { id: "Q-TAN", caption: "Tan Guoqiang", score: 0.909, topics: ["role.pep", "role.diplo"] },
  { id: "Q-LE", caption: "Lê Quốc Dung", score: 0.818, topics: [] },
];

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

  it("says how many other people the name matched, for a review of them all", () => {
    const page = text(render(<ScreeningMatch orgSlug="studio" counterparty={{ ...MATCHED, matches: SEVERAL }} canDismiss liveScreening />));
    expect(page).toContain("The name also matched 2 other people; Not this person lists them all.");
    expect(page).toContain("Not this person");
    expect(page).not.toContain("Screen again");
  });

  it("lists every match in the dismissal, sends each one, and dismisses them all with one reason", () => {
    const markup = render(
      <Dialog open>
        <DismissForm orgSlug="studio" counterparty={{ ...MATCHED, matches: SEVERAL }} matches={SEVERAL} />
      </Dialog>
    );
    expect([...markup.matchAll(/name="matchedEntityId" value="([^"]+)"/g)].map((found) => found[1])).toEqual(["Q-PEP", "Q-TAN", "Q-LE"]);
    const form = text(markup);
    expect(form).toContain("Tan Guoqiang role.pep, role.diplo 0.909");
    expect(form).toContain("Lê Quốc Dung 0.818");
    expect(form).toContain("Dismiss all 3 matches");
    // One match alone reads as before.
    expect(text(render(<Dialog open><DismissForm orgSlug="studio" counterparty={MATCHED} matches={[PEP]} /></Dialog>))).toContain("Dismiss the match");
  });

  it("offers Screen again for a live match recorded before the screening kept every match it found", () => {
    const old = { ...MATCHED, riskEntityId: null, matches: null };
    const page = text(render(<ScreeningMatch orgSlug="studio" counterparty={old} canDismiss liveScreening />));
    expect(page).toContain("This match was recorded before Vestiarion kept every possible match.");
    expect(page).toContain("Screen again");
    expect(page).not.toContain("Not this person");
    // Not for a bundled match, which never names one, nor for a member who cannot dismiss, nor once it names one.
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={old} canDismiss />))).not.toContain("Screen again");
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={old} canDismiss={false} liveScreening />))).not.toContain("Screen again");
    expect(text(render(<ScreeningMatch orgSlug="studio" counterparty={MATCHED} canDismiss liveScreening />))).not.toContain("Screen again");
    // A verdict that named its match but kept no list (between migrations 0051 and 0060) is screened again too.
    const unlisted = text(render(<ScreeningMatch orgSlug="studio" counterparty={{ ...MATCHED, matches: null }} canDismiss liveScreening />));
    expect(unlisted).toContain("Screen again");
    expect(unlisted).not.toContain("Not this person");
  });

  it("shows nothing for a clear counterparty", () => {
    expect(render(<ScreeningMatch orgSlug="studio" counterparty={{ ...MATCHED, riskLevel: "clear" }} canDismiss />)).toBe("");
  });
});
