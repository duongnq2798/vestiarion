import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { payConfirmTitle } from "@/components/ApprovalCard";
import { goLiveStatusLine } from "@/components/GoLivePanel";
import { payFreelancerNote } from "@/components/intake/PayFreelancerForm";
import { PayeeJourney } from "@/components/payee/PayeeJourney";
import ShadowModeSummary from "@/components/ShadowModeSummary";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { UsycReservePanel } from "@/components/UsycReservePanel";
import { balanceTileCopy, balanceTileMode } from "@/components/vx/Treasury";
import { headerCapability, statusChips, statusRows, type PageStatus, type PlatformStatus, type StatusTone } from "@/components/vx/workspace-status";
import {
  agreeAndPayLine,
  agreedPaymentLine,
  apiPayments,
  capabilityOf,
  paysOnChain,
  paysSimulated,
  SIMULATED_PAYMENT,
  SITUATIONS,
  type Capability,
  type CapabilityFacts,
  type Situation,
} from "@/lib/capability";
import { payeeLinkEmail } from "@/lib/email/payee-link";
import { MAINNET_NOT_LIVE } from "@/lib/mainnet";
import { ARC_TESTNET } from "@/lib/network";
import type { GoLiveStatus } from "@/lib/platform/go-live";
import type { PayeeLinkStatus } from "@/lib/payee-journey";
import type { UsycReserveStatus } from "@/lib/platform/usyc-reserve";

/**
 * One capability, the same words and tones on every surface (docs/superpowers/specs/2026-10-14-capability-and-reasons-
 * design.md R1-R8). Each row is one of the five situations, or one cause of the fifth: a live Arc mainnet workspace, a
 * live Arc testnet one, a sandbox that simulates, shadow mode (paying on chain after a verdict, or simulated), and
 * payments unavailable (switched off, the switch not read, the workspace held). For each, every surface that tells a
 * person what a payment does is read from the same facts, and checked: the header's chip and status row, shadow mode's
 * line, Agree and pay, Approve and pay's title, the balance tile, Go live's badge, Pay a freelancer, the payee's page
 * and email, and the status API. Then, across all of them, that none can be told apart wrongly: no live words where
 * payments are simulated, no simulated words where they move on chain, and no paying words where nothing can be paid.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/payee/[token]/actions", () => ({ submitPayeeAddressAction: vi.fn() }));
vi.mock("@/app/actions/test-usdc", () => ({ addTestUsdcAction: vi.fn() }));
vi.mock("@/app/actions/go-live", () => ({
  chooseHostedWalletAction: vi.fn(),
  connectCircleAction: vi.fn(),
  createWalletsAction: vi.fn(),
  goLiveAction: vi.fn(),
  refreshBalanceAction: vi.fn(),
}));
vi.mock("@/app/actions/wallet-treasury", () => ({
  proofMessageAction: vi.fn(),
  chooseWalletTreasuryAction: vi.fn(),
  createAgentWalletAction: vi.fn(),
  prepareDeploymentAction: vi.fn(),
  recordDeploymentAction: vi.fn(),
  prepareApprovalAction: vi.fn(),
  recordApprovalAction: vi.fn(),
  prepareAgentGasAction: vi.fn(),
  choosePasskeyTreasuryAction: vi.fn(),
  preparePasskeySetupAction: vi.fn(),
  recordPasskeySetupAction: vi.fn(),
  recordRecoveryAction: vi.fn(),
  skipRecoveryAction: vi.fn(),
}));
vi.mock("@/app/actions/approvals", () => ({ approveInvoiceAction: vi.fn(), rejectInvoiceAction: vi.fn(), returnInvoiceAction: vi.fn(), addInvoiceDetailsAction: vi.fn() }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/treasury", () => ({ bringCashBackAction: vi.fn(), enableUsycReserveAction: vi.fn() }));
vi.mock("@/app/actions/pay-freelancer", () => ({ payFreelancerAction: vi.fn() }));

const text = (node: ReactElement) =>
  renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const ON = { state: "on" } as const;

/** A payment said to go, or to have gone, on a network: within one sentence, a paying word, then "on Arc …". */
const PAID_ON_A_NETWORK = /\b(paid|pays?|sent|paying|For [^.]+,)\b[^.]*? on Arc (testnet|mainnet)/;

interface Row {
  name: string;
  situation: Situation;
  facts: CapabilityFacts;
  /** The header's Payments chip and row. */
  chip: { label: string; tone: StatusTone };
  row: { value: string; tone: StatusTone; detail: string };
  /** What agreeing pays, in shadow mode's panel and on its cards. */
  agreed: string;
  /** Agree and pay's confirmation; null when it is not offered. */
  agreeAndPay: string | null;
  /** Whether Approve and pay's title says "(simulated)". */
  marked: boolean;
  /** The balance tile's wording, for an operating wallet that exists. */
  tile: "live" | "sandbox" | "held";
  /** Go live's badge for a live workspace. */
  goLive: string;
  /** The status API's provenance.payments. */
  api: "live" | "simulate" | "unavailable";
}

const ROWS: Row[] = [
  {
    name: "live on Arc mainnet",
    situation: "live-mainnet",
    facts: { network: "arc-mainnet", payments: ON, hold: null, chainMode: "live", shadow: false },
    chip: { label: "Payments live", tone: "mainnet" },
    row: { value: "Live", tone: "mainnet", detail: "Approved payments move real USDC on Arc mainnet." },
    agreed: "A payment you agree to is sent in USDC on Arc mainnet.",
    agreeAndPay: "You agree with the agent, and it is paid in USDC on Arc mainnet now.",
    marked: false,
    tile: "live",
    goLive: "Live · paying on Arc mainnet",
    api: "live",
  },
  {
    name: "live on Arc testnet",
    situation: "live-testnet",
    facts: { network: "arc-testnet", payments: ON, hold: null, chainMode: "live", shadow: false },
    chip: { label: "Payments live", tone: "good" },
    row: { value: "Live", tone: "good", detail: "Approved payments are sent in USDC on Arc testnet." },
    agreed: "A payment you agree to is sent in USDC on Arc testnet.",
    agreeAndPay: "You agree with the agent, and it is paid in USDC on Arc testnet now.",
    marked: false,
    tile: "live",
    goLive: "Live · paying on Arc testnet",
    api: "live",
  },
  {
    name: "simulated in a sandbox",
    situation: "simulated",
    facts: { network: "arc-testnet", payments: ON, hold: null, chainMode: "simulate", shadow: false },
    chip: { label: "Payments simulated", tone: "simulated" },
    row: { value: "Simulated", tone: "simulated", detail: "Payments are recorded here and nothing is sent on chain." },
    agreed: "A payment you agree to is simulated: nothing is sent on chain.",
    agreeAndPay: "You agree with the agent, and it is paid now, simulated: nothing is sent on chain.",
    marked: true,
    tile: "sandbox",
    goLive: "Sandbox · simulated payments",
    api: "simulate",
  },
  {
    name: "shadow mode, paying on chain after a verdict",
    situation: "shadow",
    facts: { network: "arc-testnet", payments: ON, hold: null, chainMode: "live", shadow: true },
    chip: { label: "Shadow mode", tone: "shadow" },
    row: {
      value: "Live, after your verdict",
      tone: "shadow",
      detail: "Nothing is paid until a person agrees with the agent. A payment you agree to is sent in USDC on Arc testnet.",
    },
    agreed: "A payment you agree to is sent in USDC on Arc testnet.",
    agreeAndPay: "You agree with the agent, and it is paid in USDC on Arc testnet now.",
    marked: false,
    tile: "live",
    goLive: "Live · shadow mode, paying after a verdict",
    api: "live",
  },
  {
    name: "shadow mode, simulated after a verdict",
    situation: "shadow",
    facts: { network: "arc-testnet", payments: ON, hold: null, chainMode: "simulate", shadow: true },
    chip: { label: "Shadow mode", tone: "shadow" },
    row: {
      value: "Simulated, after your verdict",
      tone: "shadow",
      detail: "Nothing is paid until a person agrees with the agent. A payment you agree to is simulated: nothing is sent on chain.",
    },
    agreed: "A payment you agree to is simulated: nothing is sent on chain.",
    agreeAndPay: "You agree with the agent, and it is paid now, simulated: nothing is sent on chain.",
    marked: true,
    tile: "sandbox",
    goLive: "Sandbox · shadow mode, simulated after a verdict",
    api: "simulate",
  },
  {
    name: "unavailable: payments switched off",
    situation: "unavailable",
    facts: { network: "arc-testnet", payments: { state: "off", reason: "Circle incident." }, hold: null, chainMode: "live", shadow: false },
    chip: { label: "Payments off", tone: "stopped" },
    row: { value: "Off", tone: "stopped", detail: "Payments are switched off for every workspace: Circle incident. Nothing is paid, moved or locked until they are back on." },
    agreed: "Nothing is paid when you agree right now. Payments are switched off for every workspace: Circle incident. Nothing is paid, moved or locked until they are back on.",
    agreeAndPay: null,
    marked: false,
    tile: "live",
    goLive: "Live · payments off",
    api: "unavailable",
  },
  {
    name: "unavailable: the switch could not be read",
    situation: "unavailable",
    facts: { network: "arc-testnet", payments: { state: "unread" }, hold: null, chainMode: "live", shadow: false },
    chip: { label: "Payments", tone: "unknown" },
    row: { value: "Could not be read", tone: "unknown", detail: "Whether payments are switched on could not be read, and every payment is refused until it can be." },
    agreed: "Nothing is paid when you agree right now. Whether payments are switched on could not be read, and every payment is refused until it can be.",
    agreeAndPay: null,
    marked: false,
    tile: "live",
    goLive: "Live · payments not known",
    api: "unavailable",
  },
  {
    name: "unavailable: held on Arc mainnet, not live yet",
    situation: "unavailable",
    facts: { network: "arc-mainnet", payments: ON, hold: MAINNET_NOT_LIVE, chainMode: "simulate", shadow: false },
    chip: { label: "Payments held", tone: "held" },
    row: { value: "Held", tone: "held", detail: MAINNET_NOT_LIVE },
    agreed: `Nothing is paid when you agree right now. ${MAINNET_NOT_LIVE}`,
    agreeAndPay: null,
    marked: false,
    tile: "held",
    goLive: "Live · payments held",
    api: "unavailable",
  },
];

/** The header's two inputs, as the layout and a page build them from the same facts. */
function headerInputs(facts: CapabilityFacts): { platform: PlatformStatus; page: PageStatus } {
  return {
    platform: {
      network: facts.network,
      mode: "live",
      mainnetEnabled: true,
      paymentsOff: facts.payments.state === "off" ? { reason: facts.payments.reason } : null,
      paymentsUnread: facts.payments.state === "unread",
      pause: null,
    },
    page: {
      chain: { mode: facts.chainMode, earnMode: "simulate", held: facts.hold !== null, hold: facts.hold },
      shadow: facts.shadow,
      screening: { live: false, source: "bundled list" },
      clock: { mode: "real", day: 1 },
    },
  };
}

const PAYABLE = { amount: 300, counterpartyName: "Northwind", discount: null, currency: "USDC" as const };
const WALLET = [{ kind: "operating", circle_wallet_id: "w-1", address: "0x1" }];

const goLive = (facts: CapabilityFacts, step: GoLiveStatus["step"]): GoLiveStatus =>
  ({ step, network: facts.network, mainnetOff: false, host: "own", wallets: [] }) as unknown as GoLiveStatus;

const payee = (over: Partial<PayeeLinkStatus> = {}): PayeeLinkStatus => ({
  orgName: "Northstar",
  payeeName: "Lena Ortiz",
  chain: ARC_TESTNET.circleBlockchain,
  linkState: "open",
  expiresAt: "2026-10-20T00:00:00Z",
  usedAt: null,
  statusUntil: "2026-10-20T00:00:00Z",
  address: null,
  addressConfirmed: false,
  payments: [{ kind: "milestone", title: "Logo", amount: 50, currency: "USDC", status: "verified", txRef: null, settledAt: null, scheduledFor: null }],
  ...over,
});

/** Every sentence each surface shows for this capability, by surface. */
function surfaces(row: Row, capability: Capability): Record<string, string> {
  const { platform, page } = headerInputs(row.facts);
  const chips = statusChips(platform, page);
  const payments = statusRows(platform, page).find((candidate) => candidate.key === "payments")!;
  const simulated = paysSimulated(capability);
  const email = payeeLinkEmail({
    orgName: "Northstar",
    payeeName: "Lena",
    work: "Logo",
    amount: "50",
    link: "https://www.vestiarion.xyz/payee/vxp_x",
    expiresAt: new Date("2026-10-20T00:00:00Z"),
    origin: "https://www.vestiarion.xyz",
    network: row.facts.network,
    ...(simulated ? { simulated: true } : {}),
  });
  return {
    chip: chips[1].label,
    row: `${payments.value}. ${payments.detail}`,
    summary: text(<ShadowModeSummary orgSlug="northstar" mode={{ currency: "USD", startedAt: "2026-10-07T00:00:00Z", startedBy: null }} summary={{ agreed: 0, disagreed: 0, waiting: 0 }} capability={capability} />),
    agreeAndPay: agreeAndPayLine(capability) ?? "",
    approve: payConfirmTitle(PAYABLE, simulated),
    tile: Object.values(balanceTileCopy(balanceTileMode(row.facts.chainMode, WALLET, null, capability), 0)).join(" "),
    goLive: goLiveStatusLine(goLive(row.facts, "live"), capability).label,
    freelancer: payFreelancerNote(true, capability),
    payeePage: text(<PayeeJourney token="t" status={payee()} refresh={false} simulated={simulated} />),
    payeeEmail: email.text,
  };
}

describe.each(ROWS)("$name", (row) => {
  const capability = capabilityOf(row.facts);

  it(`is the situation ${row.situation}`, () => {
    expect(capability.situation).toBe(row.situation);
    // The header reaches the same capability from the layout's and the page's facts.
    const { platform, page } = headerInputs(row.facts);
    expect(headerCapability(platform, page)).toEqual(capability);
  });

  it("draws the header's chip and Payments row in its words and tone", () => {
    const { platform, page } = headerInputs(row.facts);
    expect(statusChips(platform, page)[1]).toEqual({ key: "payments", ...row.chip });
    expect(statusRows(platform, page).find((candidate) => candidate.key === "payments")).toEqual({ key: "payments", label: "Payments", ...row.row });
  });

  it("says what agreeing pays, and Agree and pay, in its words", () => {
    expect(agreedPaymentLine(capability)).toBe(row.agreed);
    expect(agreeAndPayLine(capability)).toBe(row.agreeAndPay);
  });

  it("marks Approve and pay simulated only when it is", () => {
    expect(payConfirmTitle(PAYABLE, paysSimulated(capability)).endsWith("(simulated)")).toBe(row.marked);
  });

  it("words the balance tile, Go live's badge and the status API from it", () => {
    expect(balanceTileMode(row.facts.chainMode, WALLET, null, capability)).toBe(row.tile);
    const step = row.goLive.startsWith("Sandbox") ? "connect" : "live";
    expect(goLiveStatusLine(goLive(row.facts, step), capability).label).toBe(row.goLive);
    expect(apiPayments(capability, row.facts.chainMode)).toBe(row.api);
  });

  it("draws a live USYC reserve Held while nothing can be paid, as the header's Reserve row does", () => {
    const reserve = { liveAt: "2026-10-01T00:00:00Z", reserveBalance: 0, mode: "live", operatingAddress: null, reserveAddress: null } as unknown as UsycReserveStatus;
    const words = text(<UsycReservePanel orgSlug="northstar" status={reserve} canManage={false} capability={capability} />);
    const held = capability.situation === "unavailable" && capability.cause !== "shadow-unread";
    expect(words).toContain(held ? "Held" : "Live");
    expect(words).not.toContain(held ? " Live " : " Held ");
  });

  it("can never be told apart wrongly on any surface", () => {
    const said = surfaces(row, capability);
    const everything = Object.entries(said);
    if (paysSimulated(capability)) {
      // Simulated: no surface names a network a payment goes on, or says it is live. (The payee's address field may name
      // the network an address belongs to; no payment is said to go there.)
      for (const [surface, words] of everything) {
        expect(words, surface).not.toMatch(PAID_ON_A_NETWORK);
        expect(words, surface).not.toMatch(/Payments live|paying on/);
      }
      expect(said.approve).toMatch(/\(simulated\)$/);
      expect(said.payeePage).toContain(SIMULATED_PAYMENT);
      expect(said.payeeEmail).toContain(SIMULATED_PAYMENT);
    }
    if (paysOnChain(capability)) {
      // On chain: nothing calls it simulated, and the payee is told the network.
      for (const [surface, words] of everything) expect(words, surface).not.toMatch(/simulated/i);
      expect(said.payeePage).toMatch(PAID_ON_A_NETWORK);
      expect(said.payeeEmail).toMatch(PAID_ON_A_NETWORK);
    }
    if (capability.situation === "unavailable") {
      // Nothing can be paid: no surface says a payment is live, paying, or paid now.
      for (const [surface, words] of everything) {
        expect(words, surface).not.toMatch(/Payments live|paying on|it is paid/);
      }
      expect(said.freelancer).toBe(capability.why);
      expect(said.agreeAndPay).toBe("");
    }
    if (capability.situation === "shadow") {
      expect(said.chip).toBe("Shadow mode");
      expect(said.goLive).toContain("shadow mode");
    }
  });
});

describe("the five situations", () => {
  it("are each covered above, and the header has no sixth", () => {
    expect(new Set(ROWS.map((row) => row.situation))).toEqual(new Set(SITUATIONS));
  });

  it("tell a payee their paid payment by its own record first: a transaction on chain, or the simulator's", () => {
    const paidStatus = (txRef: string) =>
      payee({
        linkState: "used",
        usedAt: "2026-10-14T09:00:00Z",
        address: "0x1948aB0000000000000000000000000000c345a0",
        addressConfirmed: true,
        payments: [{ kind: "milestone", title: "Logo", amount: 50, currency: "USDC", status: "paid", txRef, settledAt: "2026-10-14T10:00:00Z", scheduledFor: null }],
      });
    const simulated = text(<PayeeJourney token="t" status={paidStatus("sim_abc")} refresh={false} />);
    expect(simulated).toContain("Paid (simulated)");
    expect(simulated).toContain("no USDC was sent to your wallet");
    const onChain = text(<PayeeJourney token="t" status={paidStatus(`0x${"a".repeat(64)}`)} refresh={false} simulated />);
    expect(onChain).not.toMatch(/simulated/i);
    expect(onChain).toContain("Arc testnet");
  });

  it("follow the payment gates' order: the switch, then the hold, then shadow mode, then the chain", () => {
    const all = { network: "arc-mainnet", payments: { state: "off", reason: null }, hold: MAINNET_NOT_LIVE, chainMode: "live", shadow: true } as const;
    expect(capabilityOf(all).cause).toBe("off");
    expect(capabilityOf({ ...all, payments: ON }).cause).toBe("held");
    expect(capabilityOf({ ...all, payments: ON, hold: null }).situation).toBe("shadow");
    expect(capabilityOf({ ...all, payments: ON, hold: null, shadow: null })).toMatchObject({ situation: "unavailable", cause: "shadow-unread" });
    expect(capabilityOf({ ...all, payments: ON, hold: null, shadow: false }).situation).toBe("live-mainnet");
  });
});
