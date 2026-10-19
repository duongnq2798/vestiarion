/**
 * The console's Get started checklist (spec 2026-09-30-getting-started-design
 * §1, and 2026-10-01-first-payment-design §2): six steps from an empty
 * workspace to its first payment on Arc testnet. Every tick is computed from
 * rows the console already reads — the accounts, the counterparties, the
 * payables, the on-chain payments `stats()` counts, what waits for a person,
 * and the workspace's mode — so there is nothing to store and nothing to
 * dismiss: the checklist disappears once the workspace is live and has made
 * its first payment (G1).
 *
 * Funding reads the stored balance, never Circle (G2): the console makes no
 * Circle call for it. Its balance tile reads the chain and stores the result,
 * so the step ticks itself. It stays undone while the operating wallet holds
 * no USDC, live or not: going live does not fund the wallet. For the owner's
 * own wallet, the console reads what the agent can move from the chain while
 * the stored balance is 0, and that counts instead
 * (docs/superpowers/specs/2026-10-19-own-wallet-fund-step-design.md).
 *
 * Sample rows (sample-data design §1) never tick a step: they show the agent
 * working, not the workspace set up.
 *
 * In shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md) the
 * same three steps set the workspace up, then three more run it beside how the
 * business pays today: its suppliers, its real bills, and a person's first
 * verdict on the agent's decision. That checklist hides once a verdict is given,
 * and the console's Shadow mode section says how often people agreed.
 *
 * A sandbox on Arc testnet with no wallet simulates its payments, the payee's address included, so it needs no wallet
 * to decide a bill. Its checklist starts with what leads to the agent's first decision on a real bill: a supplier, a
 * bill and the decision (in shadow mode, the first verdict). The wallet, its USDC and going live follow, under "To pay
 * on Arc", with the first payment. A live workspace, or one with a wallet, keeps the order above.
 *
 * It is the owner's checklist of onboarding by role (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md
 * R1): every variant opens with the workspace created and asks for the agent's limits, set or kept as they are, before
 * the first payment, and an owner or admin may dismiss it for good. Each step names the permission it takes (`needs`),
 * so an admin sees an owner's step as an owner's, and no step offers what a role cannot do. Approvers and accountants
 * have checklists of their own (./onboarding/role-checklists).
 */

import type { Permission } from "./auth/roles";
import { addressUnconfirmed } from "./counterparty-address";
import { networkProfile, type Network } from "./network";
import type { WalletHost } from "./config";

export type GettingStartedStepId =
  | "workspace"
  | "wallet"
  | "fund"
  | "live"
  | "payee"
  | "payable"
  | "decision"
  | "limits"
  | "payment"
  | "suppliers"
  | "bills"
  | "verdict"
  // An approver's (onboarding by role R2).
  | "approvals"
  | "held_reason"
  | "decide"
  // An accountant's (R3).
  | "console"
  | "queue"
  | "book"
  | "handoff";

/** Whose checklist it is (R1 to R3): an admin follows the owner's, and a viewer has none. */
export type ChecklistRole = "owner" | "approver" | "accountant";

export interface GettingStartedInput {
  mode: "sandbox" | "live";
  accounts: Array<{ kind: string; circle_wallet_id: string | null; balance: number; address?: string | null }>;
  counterparties: Array<{
    name?: string;
    role?: string;
    address: string | null;
    address_changed_at?: string | null;
    address_confirmed_at?: string | null;
    sample?: boolean;
  }>;
  /** Open payable invoices of counterparties a person added (`ownPayableCount`). */
  payableCount: number;
  /** Every bill of a counterparty a person added, paid or not (`ownBillCount`): a sandbox's simulated payment closes one. */
  billCount?: number;
  /** Those bills the agent has decided on (`ownDecidedCount`). */
  decidedCount?: number;
  /** Paid invoices and milestones with an on-chain transaction (`stats().onchainTransfers`). */
  onchainPayments: number;
  /** Payables waiting for a person's decision, as the console's Needs you tile counts them. */
  waitingCount: number;
  /** The workspace's network: the steps name it, and offer only what it has (mainnet copy C1, C2). */
  network: Network;
  /** Whose wallets it pays from: its owner's own wallet is `external` (wallet treasury W1). */
  walletHost?: WalletHost | null;
  /** Whether this deployment offers paying from the owner's own wallet on the network (W2). */
  walletTreasuryAvailable?: boolean;
  /**
   * What the agent can move from the owner's own wallet, read from the chain for this page (`agentMovableUsdc`): the
   * lesser of its USDC and its approval to the contract. Counted instead of the stored balance when present, since only
   * a cycle or the balance tile writes that (own wallet fund step F1, F3). Null or absent, the stored balance counts.
   */
  movableUsdc?: number | null;
  /**
   * Shadow mode, when it is on: the currency bills are entered in, the verdicts people gave, and every bill of a
   * counterparty a person added, paid or not (`ownBillCount`). Null or absent outside it.
   */
  shadow?: { currency: string; verdictsGiven: number; billCount: number } | null;
  /**
   * The agent's spending limit as it stands, and whether a person set it, or the two-approval figure, or kept them as
   * they are (`limits_confirmed`): "Set or confirm the limits" (R1). Absent, nobody has.
   */
  limits?: { confirmed: boolean; dailyUsdc: number | null; weeklyUsdc: number | null } | null;
  /** This person dismissed the owner's checklist for good (`dismissed_owner`, R4). */
  dismissed?: boolean;
}

export interface GettingStartedStep {
  id: GettingStartedStepId;
  title: string;
  body: string;
  /** Where the step is done, relative to the workspace (`orgHref(slug, path)`). */
  path: string;
  /** Where the step is done when that is outside the workspace (the accountant console, a download): used as it is. */
  href?: string;
  /** The link downloads a file rather than opening a page (an accountant's hand-off). */
  download?: boolean;
  done: boolean;
  /** Only an owner can take this step; an admin sees it but not its controls. */
  ownerOnly: boolean;
  /** The permission taking the step needs (`roles.ts`), or null when anyone can: the checklist never offers more (R5). */
  needs: Permission | null;
  /** The heading the step is listed under, when the checklist groups its steps: "To pay on Arc" in a sandbox with no wallet. */
  section?: string;
}

export interface GettingStarted {
  /** Whose checklist it is; the owner's when absent. */
  role?: ChecklistRole;
  /** The section's title when it is not "Get started": the shadow mode checklist names itself. */
  title?: string;
  /** False once the workspace is live and has made its first payment on Arc testnet: the checklist is done and hides. */
  show: boolean;
  steps: GettingStartedStep[];
  /** The first step not done, or null when every one is. */
  next: GettingStartedStepId | null;
  /**
   * The guide for where the workspace is: going live, then its first payment; or running in shadow mode. An approver's
   * opens the first-payment guide at deciding a held payment, and an accountant's the accountants guide.
   */
  guide: "go-live" | "first-payment" | "shadow-mode" | "first-payment#6-approve-a-held-payment" | "accountants";
}

const GO_LIVE = "/settings#go-live-title";
/** Where a sandbox with no wallet lists the steps to real payments, after its first decision. */
export const PAY_ON_ARC = "To pay on Arc";
const SETTINGS_STEPS: ReadonlySet<GettingStartedStepId> = new Set(["wallet", "fund", "live"]);
/** The agent's spending limit on the console (`AgentBudgetPanel`). */
export const LIMITS_PATH = "/console#agent-budget";

/** The workspace exists once its console shows this: the first of the owner's steps, always done (R1). */
const WORKSPACE_STEP: GettingStartedStep = {
  id: "workspace",
  title: "Create the workspace",
  body: "",
  path: "/settings",
  done: true,
  ownerOnly: false,
  needs: null,
};

const usdc = (value: number) => `${value.toFixed(2)} USDC`;

/** "Set or confirm the limits" (R1): the agent's spending limit as it stands, set by a person or kept as it is. */
function limitsStep(limits: GettingStartedInput["limits"]): GettingStartedStep {
  const daily = limits?.dailyUsdc ?? null;
  const weekly = limits?.weeklyUsdc ?? null;
  const figures =
    daily !== null && weekly !== null
      ? `at most ${usdc(daily)} a day and ${usdc(weekly)} in 7 days`
      : daily !== null
        ? `at most ${usdc(daily)} a day, with no 7-day limit`
        : weekly !== null
          ? `at most ${usdc(weekly)} in 7 days, with no daily limit`
          : null;
  return {
    id: "limits",
    title: "Set or confirm the limits",
    body: figures
      ? `On its own, the agent pays ${figures}, and each supplier no more than its payment limit. Change them on Agent spending limit, or keep them as they are.`
      : "The agent has no daily or 7-day spending limit: on its own it pays each supplier up to its payment limit. Set one on Agent spending limit, or keep it as it is.",
    path: LIMITS_PATH,
    done: limits?.confirmed === true,
    ownerOnly: false,
    needs: "agent.budget",
  };
}

export function gettingStarted(input: GettingStartedInput): GettingStarted {
  const live = input.mode === "live";
  const operating = input.accounts.find((account) => account.kind === "operating");
  // The owner's own wallet is the workspace's once its address is the operating account's (wallet treasury W12).
  const ownWallet = input.walletHost === "external";
  const hasWallet = Boolean(operating?.circle_wallet_id) || (ownWallet && Boolean(operating?.address));
  const balance = ownWallet && typeof input.movableUsdc === "number" ? input.movableUsdc : (operating?.balance ?? 0);
  const funded = (live || hasWallet) && balance > 0;
  const payees = input.counterparties.filter(
    (counterparty) => !counterparty.sample && counterparty.role !== "client" && Boolean(counterparty.address)
  );
  const payable = payees.find((payee) => !addressUnconfirmed(payee.address_changed_at ?? null, payee.address_confirmed_at ?? null));
  const unconfirmed = payable ? undefined : payees[0];
  const paid = input.onchainPayments > 0;
  const held = input.waitingCount > 0;
  // Arc mainnet never simulates (mainnet go-live M5): only an Arc testnet sandbox decides a bill before its wallet.
  const billFirst = !live && !hasWallet && input.network === "arc-testnet";
  // There a supplier needs no address: a sandbox simulates the payee's (the orchestrator's `addressMissing`).
  const suppliers = input.counterparties.filter((counterparty) => !counterparty.sample && counterparty.role !== "client");
  const profile = networkProfile(input.network);
  const { label } = profile;
  // Where real USDC is sent, the wallet keeps a little aside for its own gas (mainnet go-live M6).
  const gas = profile.gasReserveUsdc > 0 ? ` The wallet keeps ${profile.gasReserveUsdc.toFixed(2)} USDC of it aside to pay its own gas.` : "";

  const setup: GettingStartedStep[] = [
    {
      id: "wallet",
      title: "Add a wallet",
      body: profile.hostedWallets
        ? `Create the workspace's treasury wallets on ${label}: a hosted wallet in one click, or your own Circle account.`
        : input.walletTreasuryAvailable
          ? `Use a wallet you hold, such as MetaMask, as the workspace's treasury on ${label}, or connect your own Circle account.`
          : `Create the workspace's wallet on ${label} with your own Circle account.`,
      path: GO_LIVE,
      done: live || hasWallet,
      ownerOnly: true,
      needs: "org.administer",
    },
    {
      id: "fund",
      title: "Fund it with USDC",
      body: ownWallet
        ? live
          ? `Your wallet holds no USDC the agent can move, so the agent cannot pay. Add USDC on ${label} to it, the workspace's treasury.`
          : `Add USDC on ${label} to your own wallet, the workspace's treasury. Settings reads what the agent can move from the chain.`
        : profile.faucet
        ? live
          ? "The operating wallet holds no USDC, so the agent cannot pay. Send testnet USDC to it from Circle's faucet: Settings lists its address."
          : "Send testnet USDC to the operating wallet from Circle's faucet. Settings shows the wallet's address, and reads the balance from the chain again when you come back."
        : live
          ? `The operating wallet holds no USDC, so the agent cannot pay. Send USDC on ${label} to it: Settings lists its address.${gas}`
          : `Send USDC on ${label} to the operating wallet. Settings shows the wallet's address, and reads the balance from the chain again when you come back.${gas}`,
      path: GO_LIVE,
      done: funded,
      ownerOnly: false,
      needs: null,
    },
    {
      id: "live",
      title: "Go live",
      body: "Let the agent run every 6 hours on its own, and keep the workspace: a live workspace is not deleted when inactive.",
      path: GO_LIVE,
      done: live,
      ownerOnly: true,
      needs: "org.administer",
    },
  ];

  const firstPayment: GettingStartedStep = {
    id: "payment",
    title: `First payment on ${label}`,
    body: held
      ? "The agent is holding a payable for a person: decide it on Approvals."
      : "The agent pays the payable on its own, or holds it for you on Approvals. A settled payment links to the Arc explorer.",
    path: held ? "/approvals" : "/invoices",
    done: paid,
    ownerOnly: false,
    needs: held ? "approval.decide" : null,
  };
  const limits = limitsStep(input.limits);
  const dismissed = input.dismissed === true;

  if (input.shadow) {
    const shadow = shadowChecklist(input.shadow, setup, limits, { payable, unconfirmed, held, label, billFirst, supplierAdded: suppliers.length > 0 });
    return { ...shadow, show: shadow.show && !dismissed };
  }

  if (billFirst) {
    const first: GettingStartedStep[] = [
      WORKSPACE_STEP,
      {
        id: "payee",
        title: "Add a supplier",
        body: "A vendor or contractor you pay, with the most the agent may pay it on one bill. Its Arc address can wait: a sandbox simulates the payment.",
        path: "/counterparties?add",
        done: suppliers.length > 0,
        ownerOnly: false,
        needs: "records.write",
      },
      {
        id: "payable",
        title: "Add or import a first bill",
        body: "One of your bills from that supplier, in Bills & receivables: New, then Bill to pay or From a document, or Import a list for many. Tick Goods or services received once they have come. The agent decides on it within a minute.",
        path: "/invoices?new=bill",
        done: (input.billCount ?? input.payableCount) > 0,
        ownerOnly: false,
        needs: "records.write",
      },
      {
        id: "decision",
        title: "See the agent's decision",
        body: "Its card in Bills & receivables says what the agent decided and why. A payment it makes in a sandbox is simulated.",
        path: "/invoices",
        done: (input.decidedCount ?? 0) > 0 || held,
        ownerOnly: false,
        needs: null,
      },
      limits,
    ];
    const steps: GettingStartedStep[] = [...first, ...[...setup, firstPayment].map((step) => ({ ...step, section: PAY_ON_ARC }))];
    // The first-payment guide walks the steps to the agent's first decision; the Go live guide the rest.
    const decided = first.every((step) => step.done || step.id === "limits");
    return { show: !dismissed, steps, next: steps.find((step) => !step.done)?.id ?? null, guide: decided ? "go-live" : "first-payment" };
  }

  const steps: GettingStartedStep[] = [
    WORKSPACE_STEP,
    ...setup,
    {
      id: "payee",
      title: "Add a payee with an Arc address",
      body: unconfirmed
        ? `Confirm the new address of ${unconfirmed.name ?? "your payee"} on its card: the agent holds every payment to an address that is not yet confirmed.`
        : `A vendor or contractor, with their address on ${label}. Don't have it? Ask for address, on their card, sends them a link to enter it.`,
      path: "/counterparties",
      done: Boolean(payable),
      ownerOnly: false,
      needs: "records.write",
    },
    {
      id: "payable",
      title: "Add or import a first bill",
      body: "An invoice from that payee, within its payment limit, with a PO reference and Goods or services received ticked: New, then Bill to pay, or Import a list for many. The agent decides on it within a minute.",
      path: "/invoices?new=bill",
      done: input.payableCount > 0,
      ownerOnly: false,
      needs: "records.write",
    },
    limits,
    firstPayment,
  ];

  const next = steps.find((step) => !step.done)?.id ?? null;
  return {
    show: !(paid && live) && !dismissed,
    steps,
    next,
    guide: steps.some((step) => SETTINGS_STEPS.has(step.id) && !step.done) ? "go-live" : "first-payment",
  };
}

/**
 * The checklist in shadow mode: the workspace set up, then its suppliers, its real bills and a person's first verdict.
 * In a sandbox with no wallet (`billFirst`) the verdict comes first, and the setup follows under "To pay on Arc".
 */
function shadowChecklist(
  shadow: NonNullable<GettingStartedInput["shadow"]>,
  setup: GettingStartedStep[],
  limits: GettingStartedStep,
  facts: { payable: unknown; unconfirmed: { name?: string } | undefined; held: boolean; label: string; billFirst: boolean; supplierAdded: boolean }
): GettingStarted {
  const inUsdc = shadow.currency === "USDC";
  const agreePays = facts.billFirst ? "Agree and pay pays it, simulated in this sandbox" : `Agree and pay pays it in USDC on ${facts.label}`;
  const run: GettingStartedStep[] = [
    {
      id: "suppliers",
      title: "Add your suppliers",
      body: facts.billFirst
        ? "Each supplier you pay, in Counterparties, and whether it sends you purchase orders. Its Arc address can wait: a sandbox simulates the payment."
        : facts.unconfirmed
        ? `Confirm the new address of ${facts.unconfirmed.name ?? "your supplier"} on its card: the agent holds every payment to an address that is not yet confirmed.`
        : `Each supplier you pay, in Counterparties. One with no address on ${facts.label} gets a mirror address in one click: Give it a mirror address, on its row. If it sends you no purchase orders, choose Change beside them, then Pay without purchase orders.`,
      path: "/counterparties",
      done: facts.billFirst ? facts.supplierAdded : Boolean(facts.payable),
      ownerOnly: false,
      needs: "records.write",
    },
    {
      id: "bills",
      title: "Add your real bills",
      body: inUsdc
        ? "Each bill as you receive it, as a payable in Bills & receivables, in USDC, as on any invoice. Tick Goods or services received once they have come. You keep paying it as you do today."
        : `Each bill as you receive it, as a payable in Bills & receivables, in ${shadow.currency}, as written on it: it is paid in USDC at the day's rate. Tick Goods or services received once they have come. You keep paying it as you do today.`,
      path: "/invoices",
      done: shadow.billCount > 0,
      ownerOnly: false,
      needs: "records.write",
    },
    {
      id: "verdict",
      title: "Give your first verdict",
      body: facts.held
        ? `The agent decided on a bill, and it waits for you on Approvals. ${agreePays}; Disagree, with your reason, does not.`
        : `The agent decides on each bill within a minute. Its card then asks Do you agree with the agent? ${agreePays}; Disagree, with your reason, does not.`,
      path: facts.held ? "/approvals" : "/invoices",
      done: shadow.verdictsGiven > 0,
      ownerOnly: false,
      needs: "approval.decide",
    },
    limits,
  ];
  const steps = facts.billFirst
    ? [WORKSPACE_STEP, ...run, ...setup.map((step) => ({ ...step, section: PAY_ON_ARC }))]
    : [WORKSPACE_STEP, ...setup, ...run];
  return {
    title: "Get started in shadow mode",
    show: steps.some((step) => !step.done),
    steps,
    next: steps.find((step) => !step.done)?.id ?? null,
    guide: "shadow-mode",
  };
}

/** A payable in one of these can no longer become a payment: paid already (in a sandbox, if the checklist still shows), or rejected. */
const CLOSED = new Set(["paid", "rejected"]);

/**
 * The open payables of counterparties a person added: receivables, closed
 * payables, and the invoices of sample counterparties do not count towards
 * "Add a payable". Computed from the rows the console already reads.
 */
export function ownPayableCount(
  invoices: Array<{ counterparty_id: string; direction: string; status?: string }>,
  counterparties: Array<{ id: string; sample?: boolean }>
): number {
  const sample = new Set(counterparties.filter((counterparty) => counterparty.sample).map((counterparty) => counterparty.id));
  return invoices.filter(
    (invoice) => invoice.direction === "payable" && !CLOSED.has(invoice.status ?? "") && !sample.has(invoice.counterparty_id)
  ).length;
}

/**
 * Every bill of a counterparty a person added, paid or not: in shadow mode a bill the agent decided on and a person
 * agreed to pay is still one the workspace added, so "Add your real bills" stays done. Receivables and sample
 * counterparties' invoices do not count.
 */
export function ownBillCount(invoices: Array<{ counterparty_id: string; direction: string }>, counterparties: Array<{ id: string; sample?: boolean }>): number {
  const sample = new Set(counterparties.filter((counterparty) => counterparty.sample).map((counterparty) => counterparty.id));
  return invoices.filter((invoice) => invoice.direction === "payable" && !sample.has(invoice.counterparty_id)).length;
}

/**
 * Those bills the agent has decided on: a payable leaves `pending` once a cycle pays, schedules, holds or flags it, or
 * asks for what it lacks. "See the agent's decision" is done with the first.
 */
export function ownDecidedCount(
  invoices: Array<{ counterparty_id: string; direction: string; status?: string }>,
  counterparties: Array<{ id: string; sample?: boolean }>
): number {
  const sample = new Set(counterparties.filter((counterparty) => counterparty.sample).map((counterparty) => counterparty.id));
  return invoices.filter(
    (invoice) => invoice.direction === "payable" && (invoice.status ?? "pending") !== "pending" && !sample.has(invoice.counterparty_id)
  ).length;
}
