import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "@/components/landing/Hero";
import { LiveProof, NetworkPanels } from "@/components/landing/LiveProof";
import { landingProvenance, RESERVE_PROOF_HREF } from "@/components/landing/provenance";
import { ProvenanceBar } from "@/components/vx/Provenance";
import type { OpenNumbers, SideNumbers } from "@/lib/platform/open-numbers";

/**
 * The landing's proof (docs/superpowers/specs/2026-10-08-landing-proof-design.md): the hero's live legs link to what
 * shows them live, and the measurements are the open numbers, Arc mainnet apart from Arc testnet and customers apart
 * from the team, never added together.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

function side(figures: Partial<SideNumbers> = {}): SideNumbers {
  return {
    workspacesOpened: 0,
    liveWorkspaces: 0,
    people: 0,
    payments: 0,
    usdcPaid: 0,
    payees: 0,
    invoicesDecided: 0,
    milestonesReleased: 0,
    cycles: 0,
    modelDecisions: 0,
    policyDepartures: 0,
    refusedByCode: 0,
    usdcInWallets: 0,
    firstPayments: 0,
    medianMinutesToFirstPayment: null,
    decisionsCarriedOut: null,
    decisionsEscalated: null,
    escalationsResolved: null,
    flagsResolved: null,
    flagsUpheld: null,
    invoicesPaidOnArc: null,
    invoicesPaidOnTime: null,
    invoicesPaidOnTimeUntouched: null,
    duplicatesCaught: null,
    verdictsGiven: null,
    verdictsAgreed: null,
    ...figures,
  };
}

const MAINNET_TX = `0x${"ce".repeat(32)}`;
const TESTNET_TX = `0x${"b3".repeat(32)}`;

const MAINNET: OpenNumbers = {
  generatedAt: "2026-10-08T07:00:00Z",
  sides: {
    customers: side(),
    ours: side({ workspacesOpened: 1, liveWorkspaces: 1, payments: 1, usdcPaid: 0.1, invoicesPaidOnArc: 1, invoicesPaidOnTime: 1 }),
    total: side({ workspacesOpened: 1, liveWorkspaces: 1, payments: 1, usdcPaid: 0.1, invoicesPaidOnArc: 1, invoicesPaidOnTime: 1 }),
  },
  daily: [],
  ourPayments: [{ at: "2026-10-07T09:43:00Z", amount: 0.1, txHash: MAINNET_TX, chain: null }],
};

const TESTNET: OpenNumbers = {
  generatedAt: "2026-10-08T07:00:00Z",
  sides: {
    customers: side({ workspacesOpened: 5, liveWorkspaces: 3, firstPayments: 2, payments: 2, usdcPaid: 22, payees: 2, verdictsGiven: 4, verdictsAgreed: 3 }),
    ours: side({ workspacesOpened: 9, liveWorkspaces: 6, payments: 89, usdcPaid: 122.26 }),
    total: side({ workspacesOpened: 14, liveWorkspaces: 9, firstPayments: 8, payments: 91, usdcPaid: 144.26, invoicesPaidOnArc: 73, invoicesPaidOnTime: 69 }),
  },
  daily: [],
  ourPayments: [{ at: "2026-10-08T06:10:00Z", amount: 2.7, txHash: TESTNET_TX, chain: null }],
};

describe("the landing's open numbers", () => {
  it("show Arc mainnet first, then Arc testnet, customers' figures with the team's beside them", () => {
    const markup = renderToStaticMarkup(<NetworkPanels mainnet={MAINNET} testnet={TESTNET} />);
    const words = text(markup);
    expect(words.indexOf("Arc mainnet")).toBeLessThan(words.indexOf("Arc testnet"));
    for (const part of [
      "Real money",
      "Test money",
      "Customer workspaces Not yet",
      "None opened by anyone outside the team yet",
      "Customer workspaces 5",
      "3 live now, 2 made a first payment",
      "Payments settled 91",
      "2 by customers, 144.26 USDC in all",
      "Payments settled 1",
      "None by customers, 0.10 USDC in all",
    ]) {
      expect(words).toContain(part);
    }
  });

  it("never add Arc mainnet to Arc testnet", () => {
    const words = text(renderToStaticMarkup(<NetworkPanels mainnet={MAINNET} testnet={TESTNET} />));
    expect(words).not.toContain("92");
    expect(words).not.toContain("144.36");
    expect(words).not.toMatch(/\b15\b/);
  });

  it("link each network's latest payment by the team to its explorer", () => {
    const markup = renderToStaticMarkup(<NetworkPanels mainnet={MAINNET} testnet={TESTNET} />);
    expect(markup).toContain(`href="https://explorer.arc.io/tx/${MAINNET_TX}"`);
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/tx/${TESTNET_TX}"`);
  });

  it("say how often customers agreed with the agent in shadow mode, and the on-time share where there is no verdict", () => {
    const words = text(renderToStaticMarkup(<NetworkPanels mainnet={MAINNET} testnet={TESTNET} />));
    expect(words).toContain("Customers agreed with the agent 75%");
    expect(words).toContain("3 of 4 decisions, in shadow mode");
    expect(words).toContain("Invoices paid on time 100%");
  });

  it("say when a network's numbers could not be read, and still show the other", () => {
    const words = text(renderToStaticMarkup(<NetworkPanels mainnet={null} testnet={TESTNET} />));
    expect(words).toContain("The Arc mainnet numbers could not be read right now.");
    expect(words).toContain("Customer workspaces 5");
  });

  it("name their scope and link to the open numbers and the research note", () => {
    const markup = renderToStaticMarkup(<LiveProof numbers={new Promise(() => {})} />);
    const words = text(markup);
    expect(words).toContain("Customers' workspaces are counted apart from the team's own, and Arc mainnet apart from Arc testnet, never added together.");
    expect(words).not.toContain("founding workspace");
    expect(markup).toMatch(/<a[^>]*href="\/open"[^>]*>[^<]*Open numbers/);
    expect(markup).toMatch(/<a[^>]*href="\/docs\/research\/model-vs-policy"[^>]*>[^<]*When the model and the policy disagree/);
  });
});

describe("the hero's live legs", () => {
  const base = { paymentsLive: true, foundingReserveLive: false, reserveRunsLive: true, screeningLive: true, mainnetTxUrl: `https://explorer.arc.io/tx/${MAINNET_TX}` };

  it("call the USYC reserve live when a live workspace runs a real one, linking to its record", () => {
    const yieldLeg = landingProvenance(base).find((leg) => leg.label === "Yield");
    expect(yieldLeg).toMatchObject({ live: true, detail: "USYC reserve, Arc testnet", href: RESERVE_PROOF_HREF });
    expect(RESERVE_PROOF_HREF).toBe("/docs/research/model-vs-policy#the-treasury-with-real-usyc");
  });

  it("keep the reserve simulated, with no link, when no workspace runs a real one", () => {
    const yieldLeg = landingProvenance({ ...base, reserveRunsLive: false }).find((leg) => leg.label === "Yield");
    expect(yieldLeg?.live).toBe(false);
    expect(yieldLeg?.href).toBeUndefined();
  });

  it("call the reserve live when the founding workspace's own is, whatever the others", () => {
    expect(landingProvenance({ ...base, foundingReserveLive: true, reserveRunsLive: false }).find((leg) => leg.label === "Yield")?.live).toBe(true);
  });

  it("link payments to the latest Arc mainnet payment, or to the mainnet numbers when there is none", () => {
    expect(landingProvenance(base).find((leg) => leg.label === "Payments")?.href).toBe(`https://explorer.arc.io/tx/${MAINNET_TX}`);
    expect(landingProvenance({ ...base, mainnetTxUrl: null }).find((leg) => leg.label === "Payments")?.href).toBe("/open#mainnet");
  });

  it("render a linked leg as a link, a new tab for the explorer, and a plain leg as before", () => {
    const markup = renderToStaticMarkup(<ProvenanceBar legs={landingProvenance(base)} />);
    expect(markup).toMatch(new RegExp(`<a[^>]*href="https://explorer.arc.io/tx/${MAINNET_TX}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`));
    expect(markup).toMatch(/<a[^>]*href="\/docs\/research\/model-vs-policy#the-treasury-with-real-usyc"/);
    expect(text(markup)).toContain("See the latest payment on Arc mainnet");
    const plain = renderToStaticMarkup(<ProvenanceBar legs={[{ label: "Screening", detail: "bundled list", live: false }]} />);
    expect(plain).not.toContain("<a");
  });

  it("link the hero's Arc mainnet claim to the mainnet numbers", () => {
    const markup = renderToStaticMarkup(<Hero provenance={landingProvenance(base)} head={[]} hostedAvailable />);
    expect(markup).toMatch(/<a[^>]*href="\/open#mainnet"[^>]*>Live on Arc mainnet<\/a>/);
    expect(text(markup)).toContain("An agent for your bills · Live on Arc mainnet");
  });
});
