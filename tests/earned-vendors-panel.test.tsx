import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import EarnedVendorsPanel from "@/components/EarnedVendorsPanel";

vi.mock("@/app/actions/earned-vendors", () => ({ setEarnedVendorRuleAction: vi.fn() }));

/**
 * The "Earned vendors" section of Settings (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11, AL20),
 * rendered to static markup: the rule in force, that earning changes nothing the agent may do, the owner's field and
 * Turn off, what anyone else reads, and what it shows before the workspace's database has it.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const render = (props: Partial<Parameters<typeof EarnedVendorsPanel>[0]> = {}) =>
  renderToStaticMarkup(<EarnedVendorsPanel orgSlug="pinecrest" status={{ streak: null, ready: true }} canChange={false} {...props} />);

describe("EarnedVendorsPanel", () => {
  it("says the rule in force, and that earning changes nothing the agent may do (AL20)", () => {
    const off = text(render());
    expect(off).toContain("Earned vendors");
    expect(off).toContain("Off: no vendor is counted as earned.");
    expect(off).toContain(
      "Counted from your verdicts in shadow mode. A vendor needs a payment limit to earn it. Earning changes nothing the agent may do: Report shows which vendors earned it, and the verdicts behind each."
    );
    expect(text(render({ status: { streak: 8, ready: true } }))).toContain("On: a vendor is earned after 8 agreed verdicts in a row on the agent's decisions to pay or schedule its bills.");
  });

  it("offers an owner the number and Save, and Turn off once a rule is set", () => {
    const off = render({ canChange: true });
    expect(text(off)).toContain("Agreed verdicts in a row");
    expect(text(off)).toContain("From 5 to 50.");
    expect(off).toMatch(/<input[^>]*name="streak"/);
    expect(off).toMatch(/<button(?=[^>]*name="intent")(?=[^>]*value="save")/);
    expect(text(off)).not.toContain("Turn off");

    const on = render({ canChange: true, status: { streak: 8, ready: true } });
    expect(on).toMatch(/<input[^>]*value="8"/);
    expect(on).toMatch(/<button(?=[^>]*name="intent")(?=[^>]*value="off")/);
    expect(text(on)).toContain("Turn off");
  });

  it("tells anyone else that an owner changes it", () => {
    const viewer = render({ status: { streak: 8, ready: true } });
    expect(text(viewer)).toContain("An owner of this workspace can change it.");
    expect(viewer).not.toMatch(/name="streak"/);
  });

  it("offers nothing before the workspace's database has it", () => {
    const markup = text(render({ canChange: true, status: { streak: null, ready: false } }));
    expect(markup).toContain("Not available in this workspace yet.");
    expect(markup).not.toContain("Agreed verdicts in a row");
  });

  it("links the shadow mode guide's Earned vendors beside its heading", () => {
    expect(render()).toContain('href="/docs/guides/shadow-mode#earned-vendors"');
    expect(render()).toContain('id="earned-vendors-title"');
  });
});

describe("the Settings page", () => {
  // A server component the suite does not render: its wiring is read from its source.
  const page = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/settings/page.tsx"), "utf8").replace(/\s+/g, " ");

  it("shows the section right after Shadow mode, read best effort, an owner's to change, and not on Arc mainnet (AL11)", () => {
    const at = (id: string) => page.indexOf(`id: "${id}"`);
    expect(at("earned-vendors-title")).toBeGreaterThan(at("shadow-mode-title"));
    expect(at("earned-vendors-title")).toBeLessThan(at("reporting-currency-title"));
    expect(page).toContain('readEarnedVendorRule(db()).catch(');
    expect(page).toContain('earnedRule && membership.network !== "arc-mainnet" ?');
    expect(page).toContain('canChange={can(membership.role, "approval.policy")} />');
  });
});
