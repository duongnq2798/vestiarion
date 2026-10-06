import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GitHubPanel from "@/components/GitHubPanel";
import { noticeEmailDescription } from "@/components/intake/CounterpartyNoticeEmailEdit";
import { ProvenanceBar } from "@/components/vx/Provenance";
import { chainLegs, shellFooterLine } from "@/components/vx/Shell";
import { AccountsList } from "@/components/vx/Treasury";

/**
 * Workspace pages name their workspace's network, and draw only the features it has (docs/superpowers/specs/
 * 2026-10-06-mainnet-copy-design.md C1, C3, C5, C8). The pages are server components the suite does not render, so how
 * they wire the shell and gate a panel is read from their source, as the console's checklist wiring is.
 */

vi.mock("server-only", () => ({}));

const PAGES = ["approvals", "audit", "compliance", "console", "contractors", "counterparties", "insights", "invoices", "members", "settings"] as const;
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const page = (name: string) => source(`src/app/o/[slug]/${name}/page.tsx`);
const squash = (text: string) => text.replace(/\s+/g, " ");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the shell on the workspace's network (mainnet copy C1, C3)", () => {
  const modes = { mode: "live" as const, earnMode: "simulate" as const, held: false };

  it("names Arc testnet, beside the USYC reserve's Yield leg, as before", () => {
    expect(chainLegs("arc-testnet", modes)).toEqual([
      { label: "Payments", detail: "Arc testnet", live: true },
      { label: "Yield", detail: "USYC reserve", live: false },
    ]);
    expect(shellFooterLine("arc-testnet")).toBe("Hash-chained decisions · Ed25519 signed · Arc testnet");
  });

  it("names Arc mainnet, with no Yield leg where the network has no reserve", () => {
    expect(chainLegs("arc-mainnet", modes)).toEqual([{ label: "Payments", detail: "Arc mainnet", live: true }]);
    expect(shellFooterLine("arc-mainnet")).toBe("Hash-chained decisions · Ed25519 signed · Arc mainnet");
  });

  it("says Held, not Live or Simulated, when nothing can pay: the status API's unavailable (final review I2, mainnet copy C12)", () => {
    // Arc mainnet connected but not live, with no Circle account, or switched off: chainModes() reads live or simulate.
    for (const mode of ["live", "simulate"] as const) {
      expect(chainLegs("arc-mainnet", { mode, earnMode: "simulate", held: true })).toEqual([{ label: "Payments", detail: "Arc mainnet", live: false, held: true }]);
    }
    // Credentials that cannot be read hold Arc testnet too, both legs.
    expect(chainLegs("arc-testnet", { mode: "simulate", earnMode: "simulate", held: true })).toEqual([
      { label: "Payments", detail: "Arc testnet", live: false, held: true },
      { label: "Yield", detail: "USYC reserve", live: false, held: true },
    ]);
    const markup = text(renderToStaticMarkup(<ProvenanceBar legs={chainLegs("arc-mainnet", { mode: "live", earnMode: "simulate", held: true })} />));
    expect(markup).toContain("Held");
    expect(markup).not.toMatch(/Live|Simulated/);
  });

  it.each(PAGES)("is handed whether nothing can pay by the %s page", (name) => {
    expect(squash(page(name))).toMatch(/<ProductShell [^>]*chainModes=\{(shellModes\(\)|\{ \.\.\.modes, held: paymentsHeld\(\) \})\}/);
  });

  it("reads Held from the rule the status API reads", () => {
    expect(squash(source("src/app/api/v1/status/route.ts"))).toContain("const noPayments = paymentsHeld(config);");
  });

  it.each(PAGES)("is handed the workspace's network by the %s page", (name) => {
    expect(squash(page(name))).toMatch(/<ProductShell [^>]*network=\{access\.membership\.network\}/);
  });
});

describe("a panel for a feature the workspace's network lacks is not drawn (mainnet copy C3)", () => {
  it("reads the USYC reserve only where the network has one", () => {
    expect(squash(page("settings"))).toMatch(/networkProfile\(membership\.network\)\.usyc \? usycReserveStatus\(/);
  });

  it("reads the escrow contract only where the network has escrow", () => {
    expect(squash(page("contractors"))).toMatch(/live && networkProfile\(network\)\.escrow \? readEscrowContract\(/);
  });

  it("reads Gateway and the service budget only where the network has Gateway", () => {
    const console = squash(page("console"));
    expect(console).toMatch(/const gatewayHere = access\.membership\.mode === "live" && Boolean\(networkProfile\(access\.membership\.network\)\.gateway\);/);
    expect(console).toMatch(/gatewayHere \? readGatewayState\(/);
    expect(console).toMatch(/gatewayHere \? readServiceBudget\(/);
  });
});

describe("Settings on Arc mainnet says what stays (mainnet copy C11)", () => {
  it("tells the two-approvals panel when the workspace keeps its figure", () => {
    expect(squash(page("settings"))).toMatch(/<TwoApprovalsPanel [^>]*keepsFigure=\{membership\.network === "arc-mainnet"\}/);
  });
});

describe("workspace text names the workspace's network (mainnet copy C1, C8)", () => {
  it("tells a payee's billing contact the network its payments are confirmed on", () => {
    expect(noticeEmailDescription("vendor", "arc-testnet")).toBe(
      "Each time a payment to it is confirmed on Arc testnet, Vestiarion emails this address the amount, what it is for and the transaction. Leave it empty to send none."
    );
    expect(noticeEmailDescription("vendor", "arc-mainnet")).toContain("confirmed on Arc mainnet");
    expect(noticeEmailDescription("client", "arc-mainnet")).not.toContain("Arc testnet");
  });

  it("says a pull request's comment names the workspace's network", () => {
    const markup = text(renderToStaticMarkup(<GitHubPanel orgSlug="acme" installations={[]} canManage notice={null} network="arc-mainnet" />));
    expect(markup).toContain("with the amount and the Arc mainnet transaction");
    expect(markup).not.toContain("Arc testnet");
  });

  it("names an account's chain by its label, not Circle's id", () => {
    const accounts = (chain: string) => [{ id: "a1", name: "Operating", chain, token: "USDC", balance: 5, apy: 0, simulated: false }];
    expect(text(renderToStaticMarkup(<AccountsList accounts={accounts("ARC")} />))).toContain("Arc mainnet · USDC");
    expect(text(renderToStaticMarkup(<AccountsList accounts={accounts("ARC-TESTNET")} />))).toContain("Arc testnet · USDC");
    // A chain no network lists is shown as stored rather than dropped.
    expect(text(renderToStaticMarkup(<AccountsList accounts={accounts("SOMEWHERE")} />))).toContain("SOMEWHERE · USDC");
  });
});

describe("the docs say going live on Arc mainnet is open (final review I3, mainnet copy C13)", () => {
  it("drops the go-live guide's answer for a closed network, and ARCHITECTURE's copy still to move", () => {
    expect(source("content/docs/guides/go-live.mdx")).not.toContain("Going live on Arc mainnet is not open yet");
    expect(source("ARCHITECTURE.md")).not.toContain("which moves in phase 2c");
  });
});

describe("two platform lines that would turn false with the first mainnet workspace (mainnet copy C5)", () => {
  it("/open no longer says every workspace runs on Arc testnet", () => {
    const open = source("src/app/open/page.tsx");
    expect(open).not.toContain("where every workspace runs today");
    expect(open).toContain('about: "Payments on Arc testnet."');
  });

  it("onboarding says an owner adds a wallet, on whichever network the workspace is", () => {
    const onboarding = source("src/app/onboarding/page.tsx");
    expect(onboarding).not.toContain("adds an Arc testnet wallet");
    expect(onboarding).toContain("An owner adds a wallet from Settings, and the agent pays from it.");
  });
});
