/**
 * The console's Get started checklist (spec 2026-09-30-getting-started-design
 * §1, and 2026-10-01-first-payment-design §2): six steps from an empty
 * workspace to its first payment on Arc testnet. Every tick is computed from
 * rows the console already reads — the accounts, the counterparties, the
 * payables, the on-chain payments `stats()` counts, what waits for a person,
 * and the workspace's mode — so there is nothing to store and nothing to
 * dismiss: the checklist disappears at the first payment (G1).
 *
 * Funding reads the stored balance, never Circle (G2): the console makes no
 * Circle call for it. The step sends the person to Settings, where the Go live
 * panel reads the balance from the chain, and reads it again while it is 0.
 *
 * Sample rows (sample-data design §1) never tick a step: they show the agent
 * working, not the workspace set up.
 */

import { addressUnconfirmed } from "./counterparty-address";

export type GettingStartedStepId = "wallet" | "fund" | "live" | "payee" | "payable" | "payment";

export interface GettingStartedInput {
  mode: "sandbox" | "live";
  accounts: Array<{ kind: string; circle_wallet_id: string | null; balance: number }>;
  counterparties: Array<{
    name?: string;
    role?: string;
    address: string | null;
    address_changed_at?: string | null;
    address_confirmed_at?: string | null;
    sample?: boolean;
  }>;
  /** Payable invoices of counterparties a person added (`ownPayableCount`). */
  payableCount: number;
  /** Paid invoices and milestones with an on-chain transaction (`stats().onchainTransfers`). */
  onchainPayments: number;
  /** Payables waiting for a person's decision, as the console's Needs you tile counts them. */
  waitingCount: number;
}

export interface GettingStartedStep {
  id: GettingStartedStepId;
  title: string;
  body: string;
  /** Where the step is done, relative to the workspace (`orgHref(slug, path)`). */
  path: string;
  done: boolean;
  /** Only an owner can take this step; an admin sees it but not its controls. */
  ownerOnly: boolean;
}

export interface GettingStarted {
  /** False once the workspace has made its first payment on Arc testnet: the checklist is done and hides. */
  show: boolean;
  steps: GettingStartedStep[];
  /** The first step not done, or null when every one is. */
  next: GettingStartedStepId | null;
  /** The guide for where the workspace is: going live, then its first payment. */
  guide: "go-live" | "first-payment";
}

const GO_LIVE = "/settings#go-live-title";
const SETTINGS_STEPS: ReadonlySet<GettingStartedStepId> = new Set(["wallet", "fund", "live"]);

export function gettingStarted(input: GettingStartedInput): GettingStarted {
  const live = input.mode === "live";
  const operating = input.accounts.find((account) => account.kind === "operating");
  const hasWallet = Boolean(operating?.circle_wallet_id);
  const funded = live || (hasWallet && (operating?.balance ?? 0) > 0);
  const payees = input.counterparties.filter(
    (counterparty) => !counterparty.sample && counterparty.role !== "client" && Boolean(counterparty.address)
  );
  const payable = payees.find((payee) => !addressUnconfirmed(payee.address_changed_at ?? null, payee.address_confirmed_at ?? null));
  const unconfirmed = payable ? undefined : payees[0];
  const paid = input.onchainPayments > 0;
  const held = input.waitingCount > 0;

  const steps: GettingStartedStep[] = [
    {
      id: "wallet",
      title: "Add a wallet",
      body: "Create the workspace's treasury wallets on Arc testnet: a hosted wallet in one click, or your own Circle account.",
      path: GO_LIVE,
      done: live || hasWallet,
      ownerOnly: true,
    },
    {
      id: "fund",
      title: "Fund it with USDC",
      body: "Send testnet USDC to the operating wallet from Circle's faucet. Settings shows the wallet's address, and reads the balance from the chain again when you come back.",
      path: GO_LIVE,
      done: funded,
      ownerOnly: false,
    },
    {
      id: "live",
      title: "Go live",
      body: "Let the agent pay from the wallet, when a payable comes in and on its schedule.",
      path: GO_LIVE,
      done: live,
      ownerOnly: true,
    },
    {
      id: "payee",
      title: "Add a payee with an Arc address",
      body: unconfirmed
        ? `Confirm the new address of ${unconfirmed.name ?? "your payee"} on its card: the agent holds every payment to an address that is not yet confirmed.`
        : "A vendor or contractor, with their address on Arc testnet. Don't have it? Ask for address, on their card, sends them a link to enter it.",
      path: "/counterparties",
      done: Boolean(payable),
      ownerOnly: false,
    },
    {
      id: "payable",
      title: "Add a payable",
      body: "An invoice from that payee, within its payment limit, with a PO reference and Goods or services received ticked. The agent decides on it within a minute.",
      path: "/invoices",
      done: input.payableCount > 0,
      ownerOnly: false,
    },
    {
      id: "payment",
      title: "First payment on Arc testnet",
      body: held
        ? "The agent is holding a payable for a person: decide it on Approvals."
        : "The agent pays the payable on its own, or holds it for you on Approvals. A settled payment links to the Arc explorer.",
      path: held ? "/approvals" : "/invoices",
      done: paid,
      ownerOnly: false,
    },
  ];

  const next = steps.find((step) => !step.done)?.id ?? null;
  return {
    show: !paid,
    steps,
    next,
    guide: steps.some((step) => SETTINGS_STEPS.has(step.id) && !step.done) ? "go-live" : "first-payment",
  };
}

/**
 * The payables of counterparties a person added: receivables, and the
 * invoices of sample counterparties, do not count towards "Add a payable".
 * Computed from the rows the console already reads.
 */
export function ownPayableCount(
  invoices: Array<{ counterparty_id: string; direction: string }>,
  counterparties: Array<{ id: string; sample?: boolean }>
): number {
  const sample = new Set(counterparties.filter((counterparty) => counterparty.sample).map((counterparty) => counterparty.id));
  return invoices.filter((invoice) => invoice.direction === "payable" && !sample.has(invoice.counterparty_id)).length;
}
