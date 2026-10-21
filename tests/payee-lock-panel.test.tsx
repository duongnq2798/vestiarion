import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PayeeLockPanel, { payeeLockSentence } from "@/components/PayeeLockPanel";

vi.mock("@/app/actions/payee-lock", () => ({ setPayeeLockAction: vi.fn() }));

/**
 * The "Payee lock" section of Settings (docs/superpowers/specs/2026-10-20-payee-lock-design.md PL1), rendered to static
 * markup: what it says the lock does, who may change it, and what it shows before the workspace's database has it.
 */

const render = (props: Partial<Parameters<typeof PayeeLockPanel>[0]> = {}) =>
  renderToStaticMarkup(<PayeeLockPanel orgSlug="acme" status={{ lock: { on: false, coolingHours: 0 }, ready: true }} canChange={false} {...props} />);

describe("PayeeLockPanel", () => {
  it("says what the lock does, off and on, with its wait", () => {
    expect(payeeLockSentence({ on: false, coolingHours: 24 })).toMatch(/^Off:/);
    expect(payeeLockSentence({ on: true, coolingHours: 0 })).toBe("On: a changed address needs a recorded check by another person before it is paid.");
    expect(payeeLockSentence({ on: true, coolingHours: 24 })).toBe(
      "On: a changed address needs a recorded check by another person, and waits 24 hours before it is paid."
    );
  });

  it("offers an owner the switch and the waits, and tells anyone else who can change it", () => {
    const owner = render({ canChange: true, status: { lock: { on: true, coolingHours: 24 }, ready: true } });
    expect(owner).toContain("Turn on the payee lock");
    expect(owner).toContain("Wait after an address changes");
    for (const label of ["No wait", "4 hours", "24 hours", "48 hours", "72 hours"]) expect(owner).toContain(label);
    const viewer = render();
    expect(viewer).not.toContain("Turn on the payee lock");
    expect(viewer).toContain("An owner of this workspace can change it.");
  });

  it("offers nothing before the workspace's database has it", () => {
    const markup = render({ canChange: true, status: { lock: { on: false, coolingHours: 0 }, ready: false } });
    expect(markup).toContain("Not available in this workspace yet.");
    expect(markup).not.toContain("Turn on the payee lock");
    expect(markup).not.toContain("Download the evidence pack");
  });

  it("offers any member the evidence pack, as its page and as a download of the workspace's own file (evidence pack EP1, EP7)", () => {
    const viewer = render({ orgSlug: "pinecrest studio" });
    expect(viewer).toContain("Open the evidence pack");
    expect(viewer).toContain('href="/o/pinecrest%20studio/evidence/payee-lock"');
    expect(viewer).toContain("Download the evidence pack");
    expect(viewer).toContain('href="/api/evidence/payee-lock?org=pinecrest%20studio"');
    expect(viewer).toMatch(/<a[^>]*download/);
  });
});
