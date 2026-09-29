import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountsList, ForecastPanel, MoreLink, StatTile } from "@/components/vx/Treasury";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("StatTile", () => {
  it("is a card that lifts when it links somewhere", () => {
    const markup = html(<StatTile label="Needs you" href="/o/acme/approvals">3</StatTile>);
    expect(markup).toMatch(/^<a [^>]*href="\/o\/acme\/approvals"/);
    expect(markup).toContain("hover:-translate-y-0.5");
    expect(markup).toContain("rounded-2xl");
  });

  it("is a plain card otherwise, in the held tone when something waits", () => {
    const markup = html(<StatTile label="Needs you" tone="held">3</StatTile>);
    expect(markup).toMatch(/^<div /);
    expect(markup).toContain("bg-held-soft");
    expect(markup).toContain("border-held-line");
  });
});

describe("AccountsList", () => {
  it("hatches a simulated account and says so", () => {
    const markup = html(
      <AccountsList accounts={[{ id: "a1", name: "USYC reserve", chain: "ARC-TESTNET", token: "USYC", balance: 5000, apy: 0.045, simulated: true }]} />
    );
    expect(markup).toContain("hatch");
    expect(markup).toContain("simulated");
    expect(markup).toContain("4.50% APY");
  });
});

describe("ForecastPanel", () => {
  const forecast = { horizonDays: 14, liquid: 1000, inflow: 200, outflow: 1500, recommendation: "Hold 500.00 USDC liquid until day 30." };

  it("puts the agent's recommendation in an agent callout", () => {
    const markup = html(<ForecastPanel forecast={forecast} />);
    expect(markup).toContain("Agent recommends");
    expect(markup).toContain("bg-agent-soft");
  });

  it("says a projected shortfall in the held tone, with its sign", () => {
    const markup = html(<ForecastPanel forecast={forecast} />);
    expect(markup).toContain("text-held");
    expect(markup).toContain("−");
  });
});

describe("MoreLink", () => {
  it("is a link-styled button with an arrow", () => {
    const markup = html(<MoreLink href="/o/acme/audit">Full audit log</MoreLink>);
    expect(markup).toMatch(/^<a [^>]*href="\/o\/acme\/audit"/);
    expect(markup).toContain("text-agent");
    expect(markup).toContain("<svg");
  });
});
