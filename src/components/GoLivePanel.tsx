"use client";

import { ArrowUpRight, Rocket, Wallet } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  chooseHostedWalletAction,
  connectCircleAction,
  createWalletsAction,
  goLiveAction,
  refreshBalanceAction,
  type BalanceActionResult,
  type GoLiveActionResult,
} from "@/app/actions/go-live";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { cn } from "@/components/ui/cn";
import { useActionForm } from "@/components/ui/useActionForm";
import { fmt } from "@/components/vx/Primitives";
import { utcMinute } from "@/lib/copy";
import { FUNDING_WATCH_INTERVAL_MS, shouldReadBalanceAgain } from "@/lib/funding-watch";
import { MAINNET_OFF } from "@/lib/mainnet";
import { networkOf, networkProfile, type Network } from "@/lib/network";
import type { GoLiveStatus } from "@/lib/platform/go-live";
import AddUsdcFromChain from "@/components/treasury/AddUsdcFromChain";
import PasskeyTreasurySteps from "@/components/treasury/PasskeyTreasurySteps";
import TreasuryWalletControls from "@/components/treasury/TreasuryWalletControls";
import { WalletTreasuryChoice } from "@/components/treasury/WalletTreasuryChoice";
import WalletTreasurySteps, { WalletTreasurySummary } from "@/components/treasury/WalletTreasurySteps";
import { DocsLink } from "@/components/DocsLink";

/**
 * The Go live section of Settings (docs/superpowers/specs/2026-09-29-go-live-design.md §2).
 *
 * Everyone sees the workspace's status; an owner (`canAdminister`) takes it
 * live in three steps. Nothing secret ever reaches this component: its props
 * are `goLiveStatus`'s, which carry no credential and no wallet id, and the
 * two credential inputs start empty, are never filled back in, and are
 * cleared once Circle accepts them.
 *
 * Where the deployment has the hosted pair (`status.hostedAvailable`), step 1
 * offers a hosted testnet wallet first and the own-account form second
 * (2026-09-30-hosted-wallets-design.md); without it the step is the form alone.
 */
export interface GoLivePanelProps {
  orgSlug: string;
  status: GoLiveStatus;
  canAdminister: boolean;
  /**
   * A balance for step 3 to show instead of reading the chain. Only the docs
   * screenshots (src/app/docs-shots) set it, so their sample step makes no
   * call; Settings leaves it unset, and the step reads the chain as it appears.
   */
  sampleBalance?: number;
}

const INITIAL: GoLiveActionResult = { ok: false, message: "" };
const BALANCE_INITIAL: BalanceActionResult = { ok: false, message: "", balance: null };
const CIRCLE_CONSOLE = "https://console.circle.com";

/** What confirming Go live changes (spec §2, step 3), on the workspace's network (mainnet go-live M8). */
export function goLiveConsequences(network: Network): ReactNode {
  return (
    <>
      <span className="block">{network === "arc-mainnet" ? "Real USDC moves when the agent pays." : "Real testnet USDC moves when the agent pays."}</span>
      <span className="block">The agent runs every 6 hours on its own.</span>
      <span className="block">The workspace is no longer deleted when inactive.</span>
      <span className="mt-2 block">To stop it later, pause the agent from the console.</span>
    </>
  );
}

/** What confirming Go live changes on Arc testnet. */
export const GO_LIVE_CONSEQUENCES = goLiveConsequences("arc-testnet");

/**
 * The secret inputs are masked, and marked for password managers to leave
 * alone: nothing here is a login. Browsers ignore autocomplete="off" on a
 * password field, so each is marked a one-time code, which they neither save
 * nor fill (as TryIt does), plus the password managers' own opt-outs.
 */
const SECRET_INPUT = {
  type: "password",
  autoComplete: "one-time-code",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": "true",
  spellCheck: false,
  required: true,
  maxLength: 512,
  className: "font-mono text-xs",
} as const;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-agent underline-offset-4 hover:underline">
      {children}
      <ArrowUpRight aria-hidden className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

type StatusTone = "proof" | "held" | "simulated";

/**
 * Once Circle is connected, a sandbox's own cycles already pay through it
 * (`getChainProvider` goes live on stored credentials); only the schedule
 * waits for Go live. The line says so rather than "simulated". A hosted
 * workspace says whose wallet it is instead (hosted wallets H5).
 */
const STATUS_LINE: Record<GoLiveStatus["step"], { tone: StatusTone; label: string }> = {
  connect: { tone: "simulated", label: "Sandbox · simulated payments" },
  wallets: { tone: "held", label: "Sandbox · connected to Circle — cycles you run by hand pay for real" },
  go_live: { tone: "held", label: "Sandbox · connected to Circle — cycles you run by hand pay for real" },
  live: { tone: "proof", label: "Live · paying on Arc testnet" },
};

/** On Arc mainnet nothing is simulated, and nothing moves before Go live (mainnet go-live M4, M5). */
const MAINNET_STATUS_LINE: Record<GoLiveStatus["step"], { tone: StatusTone; label: string }> = {
  connect: { tone: "simulated", label: "Not live · Arc mainnet" },
  wallets: { tone: "held", label: "Not live · nothing moves until an owner takes it live" },
  go_live: { tone: "held", label: "Not live · nothing moves until an owner takes it live" },
  live: { tone: "proof", label: "Live · paying on Arc mainnet" },
};

const onMainnet = (status: GoLiveStatus) => status.network === "arc-mainnet";

/**
 * A hosted sandbox pays through the hosted pair once its wallets exist, as a
 * connected one does through its own; before, there is nothing to pay from.
 */
function hostedStatusLine(status: GoLiveStatus): { tone: StatusTone; label: string } {
  if (status.step === "live") return { tone: "proof", label: "Live · hosted testnet wallet on Arc" };
  return {
    tone: "held",
    label: status.wallets.length > 0 ? "Sandbox · hosted testnet wallet — cycles you run by hand pay testnet USDC" : "Sandbox · hosted testnet wallet",
  };
}

function StatusLine({ status }: { status: GoLiveStatus }) {
  // Arc mainnet switched off holds every mainnet workspace, a live one included (mainnet limits L7).
  const { tone, label } = status.mainnetOff
    ? { tone: "held" as const, label: "Arc mainnet switched off" }
    : onMainnet(status)
    ? MAINNET_STATUS_LINE[status.step]
    : status.host === "hosted" && status.step !== "connect"
      ? hostedStatusLine(status)
      : STATUS_LINE[status.step];
  return (
    // A long line wraps inside the badge at 360 px instead of overflowing the header.
    <Badge tone={tone} size="sm" dot className={cn(label.length > 30 && "whitespace-normal rounded-lg text-left")}>
      {label}
    </Badge>
  );
}

function StepHeading({ n, children }: { n: 1 | 2 | 3; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-ink-3">Step {n} of 3</p>
      <h3 className="text-sm font-semibold text-ink">{children}</h3>
    </div>
  );
}

function Address({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 break-all font-mono text-xs text-ink-2">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

function WalletList({ wallets }: { wallets: GoLiveStatus["wallets"] }) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {wallets.map((wallet) => (
        <li key={wallet.address} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-3">
          <span className="text-sm font-medium text-ink">{wallet.accountName}</span>
          <Address value={wallet.address} label={`Copy the ${wallet.accountName.toLowerCase()} wallet address`} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Step 1, and the Replace Circle credentials form: the same form, the same
 * check (spec L4). The fields keep what was typed when Circle refuses it, and
 * are cleared once it accepts.
 */
function ConnectForm({ orgSlug, idPrefix, replacing }: { orgSlug: string; idPrefix: string; replacing: boolean }) {
  const { state, formProps } = useActionForm(connectCircleAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  return (
    <form {...formProps} className="grid gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-api-key`} label="API key">
          <Input id={`${idPrefix}-api-key`} name="apiKey" {...SECRET_INPUT} />
        </Field>
        <Field id={`${idPrefix}-entity-secret`} label="Entity secret" description="The one registered for developer-controlled wallets.">
          <Input id={`${idPrefix}-entity-secret`} name="entitySecret" {...SECRET_INPUT} />
        </Field>
      </div>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      <div>
        <SubmitButton pendingLabel="Checking with Circle…">{replacing ? "Replace credentials" : "Connect Circle"}</SubmitButton>
      </div>
    </form>
  );
}

function ReplaceCredentials({ orgSlug, status }: { orgSlug: string; status: GoLiveStatus }) {
  return (
    <Disclosure summary="Replace Circle credentials">
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-2">
          New values are checked with Circle before they replace the stored ones, and are never shown again.
          {status.wallets.length > 0 && " Use the same Circle account: this workspace's wallets belong to it."}
          {status.wallets.some((wallet) => wallet.kind === "operating") && " Credentials for another account are refused."}
        </p>
        <p className="text-sm leading-relaxed text-ink-2">
          Vestiarion can confirm the API key and the wallets, but not the entity secret once wallets exist; if payments start failing with the entity
          secret rejected, pause the agent and reconnect with the right one.
        </p>
        <ConnectForm orgSlug={orgSlug} idPrefix="go-live-replace" replacing />
      </div>
    </Disclosure>
  );
}

function ConnectIntro({ network = "arc-testnet" }: { network?: Network }) {
  if (network === "arc-mainnet") {
    return (
      <p className="text-sm leading-relaxed text-ink-2">
        Paste a live API key (it starts with LIVE_API_KEY) and the entity secret registered for it, from your Circle account once it is upgraded to
        production (<ExternalLink href={CIRCLE_CONSOLE}>console.circle.com</ExternalLink>). Circle checks the key first; both values are then encrypted and never
        shown again.
      </p>
    );
  }
  return (
    <p className="text-sm leading-relaxed text-ink-2">
      Paste an API key and your entity secret from the Circle developer console (<ExternalLink href={CIRCLE_CONSOLE}>console.circle.com</ExternalLink>). Circle
      checks the key first; both values are then encrypted and never shown again.
    </p>
  );
}

/** The hosted choice (hosted wallets H4, H5): one button, no Circle account needed. */
function HostedChoice({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(chooseHostedWalletAction, INITIAL, { toastOnSuccess: true });
  return (
    <div className="space-y-3 rounded-xl border border-agent-line bg-agent-soft/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">A testnet wallet, no Circle account needed</h4>
        <Badge tone="agent" size="sm">
          Recommended
        </Badge>
      </div>
      <p className="text-sm leading-relaxed text-ink-2">
        Vestiarion creates this workspace&apos;s wallets in its own Circle testnet account, and you fund them with testnet USDC from Circle&apos;s faucet. Once the
        wallets exist, the choice is fixed.
      </p>
      <form {...formProps} className="grid gap-2">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <div>
          <SubmitButton icon={<Wallet />} pendingLabel="Choosing…">
            Use a Vestiarion testnet wallet
          </SubmitButton>
        </div>
        <p className="text-xs text-ink-3">Hosted by Vestiarion · Arc testnet</p>
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      </form>
    </div>
  );
}

/**
 * The two steps after the first, named under step 1, so a person sees where the wallets are made before connecting
 * (partner asked 2026-10-06, on Arc mainnet: "where is the wallet created?"). Every figure from the network's profile.
 */
function StepsAhead({ network }: { network: Network }) {
  const profile = networkProfile(network);
  return (
    <ol aria-label="After this step" className="space-y-1 border-t border-line pt-3 text-xs leading-relaxed text-ink-3">
      <li>
        <span className="font-medium text-ink-2">Step 2, Create treasury wallets:</span>{" "}
        {profile.usyc ? `one wallet on ${profile.label} for each of this workspace's accounts.` : `one wallet on ${profile.label}, in your own Circle account.`}
      </li>
      <li>
        <span className="font-medium text-ink-2">Step 3, Fund and go live:</span>{" "}
        {profile.faucet
          ? "add USDC from the faucet to the operating wallet, then go live."
          : `send USDC on ${profile.label} to the operating wallet, keeping ${profile.gasReserveUsdc.toFixed(2)} USDC for its gas, then go live.`}
      </li>
    </ol>
  );
}

function ConnectStep({ orgSlug, hostedAvailable, walletTreasuryAvailable, network }: { orgSlug: string; hostedAvailable: boolean; walletTreasuryAvailable: boolean; network: Network }) {
  // The owner's own wallet first, where the deployment has an agent account (wallet treasury W1, W2).
  if (walletTreasuryAvailable) {
    return (
      <Card className="space-y-4 p-5">
        <StepHeading n={1}>Choose where the treasury lives</StepHeading>
        <WalletTreasuryChoice orgSlug={orgSlug} network={network} />
        <Disclosure summary="Connect your own Circle account">
          <div className="space-y-4">
            <ConnectIntro network={network} />
            <ConnectForm orgSlug={orgSlug} idPrefix="go-live-connect" replacing={false} />
          </div>
        </Disclosure>
      </Card>
    );
  }
  if (!hostedAvailable) {
    return (
      <Card className="space-y-4 p-5">
        <StepHeading n={1}>Connect your Circle account</StepHeading>
        <ConnectIntro network={network} />
        <ConnectForm orgSlug={orgSlug} idPrefix="go-live-connect" replacing={false} />
        <StepsAhead network={network} />
      </Card>
    );
  }
  return (
    <Card className="space-y-4 p-5">
      <StepHeading n={1}>Choose where the wallets live</StepHeading>
      <HostedChoice orgSlug={orgSlug} />
      <Disclosure summary="Connect your own Circle account">
        <div className="space-y-4">
          <ConnectIntro />
          <ConnectForm orgSlug={orgSlug} idPrefix="go-live-connect" replacing={false} />
        </div>
      </Disclosure>
      <StepsAhead network={network} />
    </Card>
  );
}

/**
 * Below a hosted workspace's steps (hosted wallets H4): until its wallets
 * exist the owner may still move to their own Circle account; after, the
 * choice is fixed (`hosted_has_wallets`), and one line says what to do.
 */
function HostedOwnAccount({ orgSlug, status }: { orgSlug: string; status: GoLiveStatus }) {
  if (status.wallets.length > 0 || status.step === "go_live" || status.step === "live") {
    return <p className="text-sm text-ink-2">To use your own Circle account, start a new workspace.</p>;
  }
  return (
    <Disclosure summary="Connect your own Circle account instead">
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-2">Possible until this workspace&apos;s wallets are created; after that, the hosted wallet stays.</p>
        <ConnectIntro />
        <ConnectForm orgSlug={orgSlug} idPrefix="go-live-own" replacing={false} />
      </div>
    </Disclosure>
  );
}

function WalletsStep({ orgSlug, status }: { orgSlug: string; status: GoLiveStatus }) {
  const { state, formProps } = useActionForm(createWalletsAction, INITIAL, { toastOnSuccess: true });
  const network = networkProfile(status.network ?? "arc-testnet");
  return (
    <Card className="space-y-4 p-5">
      <StepHeading n={2}>Create treasury wallets</StepHeading>
      <p className="text-sm leading-relaxed text-ink-2">
        {onMainnet(status)
          ? "One wallet on Arc mainnet, an EOA that pays its own gas in USDC, in a wallet set in your own Circle account. Creating it also proves the entity secret."
          : status.host === "hosted"
            ? "One wallet on Arc testnet for each of this workspace's accounts, created in Vestiarion's testnet account, in a wallet set of this workspace's own."
            : "One wallet on Arc testnet for each of this workspace's accounts, in a wallet set in your own Circle account. Creating them also proves the entity secret."}
      </p>
      {status.wallets.length > 0 && <WalletList wallets={status.wallets} />}
      <form {...formProps} className="grid gap-3">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <div>
          <SubmitButton icon={<Wallet />} pendingLabel="Creating wallets…">
            Create treasury wallets
          </SubmitButton>
        </div>
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      </form>
      <Callout title="Counterparties are paid only at a real address.">
        Set each one&apos;s {network.label} address on the{" "}
        <Link href={`/o/${orgSlug}/counterparties`} className="font-medium text-agent underline-offset-4 hover:underline">
          Counterparties
        </Link>{" "}
        page. A payment to a counterparty without one is held for review.
      </Callout>
    </Card>
  );
}

/**
 * The operating wallet's balance on chain, read once when the step appears
 * and again on Refresh. While it is 0 or unread, it is also read again when
 * the tab becomes visible (back from the faucet) and every 30 s while it is,
 * for 15 minutes (first-payment design R1). The read goes through
 * `refreshBalanceAction`, which returns the number only.
 */
function BalanceLine({ orgSlug, sampleBalance }: { orgSlug: string; sampleBalance?: number }) {
  const [state, dispatch, pending] = useActionState(
    refreshBalanceAction,
    sampleBalance === undefined ? BALANCE_INITIAL : { ok: true, message: "", balance: sampleBalance }
  );
  const requested = useRef(sampleBalance !== undefined);
  // The latest balance and whether a read is running, for the watch below, which is set up once.
  const latest = useRef({ balance: state.balance, pending });
  useEffect(() => {
    latest.current = { balance: state.balance, pending };
  });

  const read = useCallback(() => {
    const data = new FormData();
    data.set("orgSlug", orgSlug);
    startTransition(() => dispatch(data));
  }, [dispatch, orgSlug]);

  useEffect(() => {
    // Once per mount, however often a development build runs this effect; never for a sample balance.
    if (requested.current) return;
    requested.current = true;
    read();
  }, [read]);

  useEffect(() => {
    const openedAt = Date.now();
    const readAgain = () => {
      const visible = document.visibilityState === "visible";
      if (shouldReadBalanceAgain({ ...latest.current, openedAt, now: Date.now(), visible, sample: sampleBalance !== undefined })) read();
    };
    const timer = setInterval(readAgain, FUNDING_WATCH_INTERVAL_MS);
    document.addEventListener("visibilitychange", readAgain);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", readAgain);
    };
  }, [read, sampleBalance]);

  const value = state.balance !== null ? `${fmt(state.balance)} USDC` : pending ? "reading…" : "not read yet";
  return (
    <form action={dispatch} className="space-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm text-ink-2">
          USDC on chain: <span className={cn("font-medium tabular-nums", state.balance !== null ? "text-ink" : "text-ink-3")}>{value}</span>
        </p>
        <Button type="submit" variant="secondary" size="sm" loading={pending}>
          Refresh
        </Button>
      </div>
      {!state.ok && state.message && <p className="text-xs text-refused">{state.message}</p>}
    </form>
  );
}

/**
 * The wallet USDC is added to from another chain (add USDC B6): the owner's wallet on path C, the operating wallet on paths
 * A and B; none until its address is known.
 */
function fundingTarget(status: GoLiveStatus): { network: Network; recipient: string; label: string } | null {
  if (status.walletTreasury) {
    return status.walletTreasury.wallet ? { network: status.network ?? "arc-mainnet", recipient: status.walletTreasury.wallet, label: "Your wallet" } : null;
  }
  const operating = status.wallets.find((wallet) => wallet.kind === "operating");
  return operating ? { network: networkOf(status.network), recipient: operating.address, label: "the operating wallet" } : null;
}

function AddUsdc({ status }: { status: GoLiveStatus }) {
  const target = fundingTarget(status);
  return target ? <AddUsdcFromChain network={target.network} recipient={target.recipient} recipientLabel={target.label} /> : null;
}

function GoLiveStep({ orgSlug, status, sampleBalance }: { orgSlug: string; status: GoLiveStatus; sampleBalance?: number }) {
  const { state, pending, formProps } = useActionForm(goLiveAction, INITIAL, { toastOnSuccess: true });
  const operating = status.wallets.find((wallet) => wallet.kind === "operating");
  const mainnet = onMainnet(status);
  // Where this network's test tokens come from, if anywhere (mainnet copy C2).
  const faucet = networkProfile(networkOf(status.network)).faucet ?? "";
  return (
    <Card className="space-y-5 p-5">
      <StepHeading n={3}>{status.host === "external" ? "Check your wallet, then go live" : "Fund the operating wallet, then go live"}</StepHeading>
      {status.walletTreasury && <WalletTreasurySummary status={status.walletTreasury} network={status.network ?? "arc-mainnet"} />}
      {operating && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">Operating wallet</p>
          <Address value={operating.address} label="Copy the operating wallet address" />
          <p className="text-sm leading-relaxed text-ink-2">
            {mainnet ? (
              "Send USDC on Arc mainnet to this address. Keep a little more than you plan to pay: the wallet pays its own gas in USDC."
            ) : (
              <>
                Get testnet USDC at <ExternalLink href={faucet}>faucet.circle.com</ExternalLink>: select Arc Testnet, and paste this address.
              </>
            )}
          </p>
          <BalanceLine orgSlug={orgSlug} sampleBalance={sampleBalance} />
        </div>
      )}
      <AddUsdc status={status} />
      <form id="go-live-form" {...formProps} className="grid gap-3 border-t border-line pt-4">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <p className="text-sm leading-relaxed text-ink-2">Going live cannot be undone from here; pausing the agent stops it paying.</p>
        {mainnet && (
          <Field id="go-live-confirmation" label="Type mainnet to confirm" description="This workspace then pays real USDC on Arc mainnet.">
            <Input id="go-live-confirmation" name="confirmation" autoComplete="off" spellCheck={false} required />
          </Field>
        )}
        <div>
          <ConfirmDialog
            formId="go-live-form"
            tone="primary"
            trigger={
              <Button icon={<Rocket />} loading={pending}>
                Go live
              </Button>
            }
            title="Take this workspace live?"
            description={goLiveConsequences(status.network ?? "arc-testnet")}
            confirmLabel="Go live"
          />
        </div>
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}

function LiveDetails({ orgSlug, status, canAdminister }: { orgSlug: string; status: GoLiveStatus; canAdminister: boolean }) {
  return (
    <div className="space-y-3">
      {status.wallets.length > 0 && <WalletList wallets={status.wallets} />}
      {status.walletTreasury && <WalletTreasurySummary status={status.walletTreasury} network={status.network ?? "arc-mainnet"} />}
      {/* The treasury's own wallet changes its contract's figures, or stops and resumes the agent (treasury wallet controls C1). */}
      {status.walletTreasury && canAdminister && <TreasuryWalletControls orgSlug={orgSlug} status={status.walletTreasury} network={status.network ?? "arc-mainnet"} />}
      {/* "Your wallet" is the owner's: a member who cannot administer the workspace is not asked to fund it (review M5). */}
      {canAdminister && <AddUsdc status={status} />}
      <div className="space-y-1 text-sm text-ink-2">
        {status.liveSince && <p>Live since {utcMinute(status.liveSince)}</p>}
        <p>
          Runs every 6 hours; pause the agent from the{" "}
          <Link href={`/o/${orgSlug}/console`} className="font-medium text-agent underline-offset-4 hover:underline">
            console
          </Link>{" "}
          to stop it.
        </p>
      </div>
    </div>
  );
}

export default function GoLivePanel({ orgSlug, status, canAdminister, sampleBalance }: GoLivePanelProps) {
  const live = status.step === "live";

  const hosted = status.host === "hosted";

  let body: ReactNode;
  if (status.mainnetOff) {
    // Arc mainnet switched off on this deployment (mainnet go-live M4): nothing moves, and no step is offered.
    body = (
      <Callout tone="held" title={MAINNET_OFF}>
        Nothing moves on this workspace until it is switched back on. Every page still reads as usual.
      </Callout>
    );
  } else if (status.credentialsUnreadable && hosted) {
    // Nothing to reconnect: the hosted pair is the deployment's, not the workspace's (hosted wallets H1).
    body = (
      <Callout tone="refused" title="Hosted testnet wallet unavailable">
        This workspace&apos;s wallets are hosted by Vestiarion, and the hosted testnet wallet is unavailable on this deployment, so it pays nothing until it is
        available again.
      </Callout>
    );
  } else if (status.credentialsUnreadable) {
    body = (
      <Callout tone="refused" title="Circle credentials cannot be read">
        This workspace&apos;s Circle credentials are stored, but this deployment cannot decrypt them, so it pays nothing until they can be read again. An owner can reconnect below.
      </Callout>
    );
  } else if (live) {
    body = <LiveDetails orgSlug={orgSlug} status={status} canAdminister={canAdminister} />;
  } else if (!canAdminister) {
    body = (
      <p className="text-sm text-ink-2">
        {hosted ? "An owner can create the wallets and take this workspace live from here." : "An owner can connect Circle and take this workspace live from here."}
      </p>
    );
  } else if (status.host === "external" && status.walletTreasury && status.step === "wallets") {
    // The owner's own wallet, set up step by step (wallet treasury W5-W10); a passkey wallet's own route (passkey treasury K5-K8).
    const treasuryNetwork = status.network ?? "arc-mainnet";
    if (status.walletTreasury.step === "wallet") {
      // The workspace chose its own wallet but holds no address for it: the choice is offered again, never a dead end.
      body = (
        <Card className="space-y-4 p-5">
          <div className="space-y-1">
            <p className="text-xs font-medium text-ink-3">Step 2 of 3</p>
            <h3 className="text-sm font-semibold text-ink">Set up your wallet as the treasury</h3>
          </div>
          <WalletTreasuryChoice orgSlug={orgSlug} network={treasuryNetwork} />
        </Card>
      );
    } else if (status.walletTreasury.signer === "passkey") {
      body = <PasskeyTreasurySteps orgSlug={orgSlug} status={status.walletTreasury} network={treasuryNetwork} />;
    } else {
      body = <WalletTreasurySteps orgSlug={orgSlug} status={status.walletTreasury} network={treasuryNetwork} />;
    }
  } else if (status.step === "connect") {
    body = (
      <ConnectStep
        orgSlug={orgSlug}
        hostedAvailable={status.hostedAvailable}
        walletTreasuryAvailable={Boolean(status.walletTreasuryAvailable)}
        network={status.network ?? "arc-testnet"}
      />
    );
  } else if (status.step === "wallets") {
    body = <WalletsStep orgSlug={orgSlug} status={status} />;
  } else {
    body = <GoLiveStep orgSlug={orgSlug} status={status} sampleBalance={sampleBalance} />;
  }

  // With unreadable credentials the warning asks an owner to reconnect, so the
  // form is offered then too; the new pair still has to pass the same checks.
  // A hosted workspace has no credentials of its own to replace.
  // A workspace paying from its owner's own wallet takes no Circle credentials at all (wallet treasury W1).
  const canReplace = canAdminister && !hosted && status.host !== "external" && !status.mainnetOff && (status.credentialsUnreadable || status.step !== "connect");

  return (
    <section aria-labelledby="go-live-title">
      <SectionHeader id="go-live-title" title="Go live" meta={<StatusLine status={status} />} action={<DocsLink href="/docs/guides/go-live" topic="going live" />} />
      <div className="space-y-4">
        {body}
        {canReplace && <ReplaceCredentials orgSlug={orgSlug} status={status} />}
        {canAdminister && hosted && <HostedOwnAccount orgSlug={orgSlug} status={status} />}
      </div>
    </section>
  );
}
