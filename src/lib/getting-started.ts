/**
 * The console's Get started checklist (spec 2026-09-30-getting-started-design
 * §1). Every tick is computed from rows the console already reads — the
 * accounts, the counterparties, how many invoices there are, and the
 * workspace's mode — so there is nothing to store and nothing to dismiss: the
 * checklist disappears when the workspace goes live (G1).
 *
 * Funding reads the stored balance, never Circle (G2): the console makes no
 * Circle call for it. A new wallet's stored balance is 0 until a live read, so
 * while it is, the step sends the person to Settings, where the live balance
 * is read.
 *
 * Sample rows (sample-data design §1) never tick a step: they show the agent
 * working, not the workspace set up.
 */

export type GettingStartedStepId = "wallet" | "fund" | "counterparty" | "invoice" | "live";

export interface GettingStartedInput {
  mode: "sandbox" | "live";
  accounts: Array<{ kind: string; circle_wallet_id: string | null; balance: number }>;
  counterparties: Array<{ address: string | null; sample?: boolean }>;
  invoiceCount: number;
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
  /** False once the workspace is live: the checklist is done and hides. */
  show: boolean;
  steps: GettingStartedStep[];
  /** The first step not done, or null when every one is. */
  next: GettingStartedStepId | null;
}

const GO_LIVE = "/settings#go-live-title";

export function gettingStarted(input: GettingStartedInput): GettingStarted {
  const live = input.mode === "live";
  const operating = input.accounts.find((account) => account.kind === "operating");
  const hasWallet = Boolean(operating?.circle_wallet_id);
  const funded = live || (hasWallet && (operating?.balance ?? 0) > 0);

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
      body:
        hasWallet && !funded
          ? "Send testnet USDC to the operating wallet from Circle's faucet. Check the balance in Settings: it is read from the chain there."
          : "Send testnet USDC to the operating wallet from Circle's faucet.",
      path: GO_LIVE,
      done: funded,
      ownerOnly: false,
    },
    {
      id: "counterparty",
      title: "Add a counterparty with an Arc address",
      body: "Someone the agent pays, with their address on Arc testnet.",
      path: "/counterparties",
      done: input.counterparties.some((counterparty) => !counterparty.sample && Boolean(counterparty.address)),
      ownerOnly: false,
    },
    {
      id: "invoice",
      title: "Add an invoice",
      body: "A payable from that counterparty, for the agent to decide on its next cycle.",
      path: "/invoices",
      done: input.invoiceCount > 0,
      ownerOnly: false,
    },
    {
      id: "live",
      title: "Go live",
      body: "Let the agent pay from the wallet, on its schedule and when you run a cycle.",
      path: GO_LIVE,
      done: live,
      ownerOnly: true,
    },
  ];

  return { show: !live, steps, next: steps.find((step) => !step.done)?.id ?? null };
}

/**
 * The invoices of counterparties a person added: sample invoices do not count
 * towards "Add an invoice". Computed from the rows the console already reads.
 */
export function ownInvoiceCount(
  invoices: Array<{ counterparty_id: string }>,
  counterparties: Array<{ id: string; sample?: boolean }>
): number {
  const sample = new Set(counterparties.filter((counterparty) => counterparty.sample).map((counterparty) => counterparty.id));
  return invoices.filter((invoice) => !sample.has(invoice.counterparty_id)).length;
}
