"use client";

import { ArrowUpRight, Rocket, Wallet } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import {
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
import type { GoLiveStatus } from "@/lib/platform/go-live";

/**
 * The Go live section of Settings (docs/superpowers/specs/2026-09-29-go-live-design.md §2).
 *
 * Everyone sees the workspace's status; an owner (`canAdminister`) takes it
 * live in three steps. Nothing secret ever reaches this component: its props
 * are `goLiveStatus`'s, which carry no credential and no wallet id, and the
 * two credential inputs start empty, are never filled back in, and are
 * cleared once Circle accepts them.
 */
export interface GoLivePanelProps {
  orgSlug: string;
  status: GoLiveStatus;
  canAdminister: boolean;
}

const INITIAL: GoLiveActionResult = { ok: false, message: "" };
const BALANCE_INITIAL: BalanceActionResult = { ok: false, message: "", balance: null };
const FAUCET = "https://faucet.circle.com";
const CIRCLE_CONSOLE = "https://console.circle.com";

/** What confirming Go live changes (spec §2, step 3). */
export const GO_LIVE_CONSEQUENCES = (
  <>
    <span className="block">Real testnet USDC moves when the agent pays.</span>
    <span className="block">The agent runs every 6 hours on its own.</span>
    <span className="block">The workspace is no longer deleted when inactive.</span>
    <span className="mt-2 block">To stop it later, pause the agent from the console.</span>
  </>
);

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

/**
 * Once Circle is connected, a sandbox's own cycles already pay through it
 * (`getChainProvider` goes live on stored credentials); only the schedule
 * waits for Go live. The line says so rather than "simulated".
 */
const STATUS_LINE: Record<GoLiveStatus["step"], { tone: "proof" | "held" | "simulated"; label: string }> = {
  connect: { tone: "simulated", label: "Sandbox · simulated payments" },
  wallets: { tone: "held", label: "Sandbox · connected to Circle — cycles you run by hand pay for real" },
  go_live: { tone: "held", label: "Sandbox · connected to Circle — cycles you run by hand pay for real" },
  live: { tone: "proof", label: "Live · paying on Arc testnet" },
};

function StatusLine({ step }: { step: GoLiveStatus["step"] }) {
  const { tone, label } = STATUS_LINE[step];
  return (
    // The connected line is long: at 360 px it wraps inside the badge instead of overflowing the header.
    <Badge tone={tone} size="sm" dot className={cn(step !== "connect" && step !== "live" && "whitespace-normal rounded-lg text-left")}>
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

function ConnectStep({ orgSlug }: { orgSlug: string }) {
  return (
    <Card className="space-y-4 p-5">
      <StepHeading n={1}>Connect your Circle account</StepHeading>
      <p className="text-sm leading-relaxed text-ink-2">
        Paste an API key and your entity secret from the Circle developer console (<ExternalLink href={CIRCLE_CONSOLE}>console.circle.com</ExternalLink>). Circle
        checks the key first; both values are then encrypted and never shown again.
      </p>
      <ConnectForm orgSlug={orgSlug} idPrefix="go-live-connect" replacing={false} />
    </Card>
  );
}

function WalletsStep({ orgSlug, status }: { orgSlug: string; status: GoLiveStatus }) {
  const { state, formProps } = useActionForm(createWalletsAction, INITIAL, { toastOnSuccess: true });
  return (
    <Card className="space-y-4 p-5">
      <StepHeading n={2}>Create treasury wallets</StepHeading>
      <p className="text-sm leading-relaxed text-ink-2">
        One wallet on Arc testnet for each of this workspace&apos;s accounts, in a wallet set in your own Circle account. Creating them also proves the entity
        secret.
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
        Set each one&apos;s Arc testnet address on the{" "}
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
 * and again on Refresh. The read goes through `refreshBalanceAction`, which
 * returns the number only.
 */
function BalanceLine({ orgSlug }: { orgSlug: string }) {
  const [state, dispatch, pending] = useActionState(refreshBalanceAction, BALANCE_INITIAL);
  const requested = useRef(false);

  useEffect(() => {
    // Once per mount, however often a development build runs this effect.
    if (requested.current) return;
    requested.current = true;
    const data = new FormData();
    data.set("orgSlug", orgSlug);
    startTransition(() => dispatch(data));
  }, [dispatch, orgSlug]);

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

function GoLiveStep({ orgSlug, status }: { orgSlug: string; status: GoLiveStatus }) {
  const { state, pending, formProps } = useActionForm(goLiveAction, INITIAL, { toastOnSuccess: true });
  const operating = status.wallets.find((wallet) => wallet.kind === "operating");
  return (
    <Card className="space-y-5 p-5">
      <StepHeading n={3}>Fund the operating wallet, then go live</StepHeading>
      {operating && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">Operating wallet</p>
          <Address value={operating.address} label="Copy the operating wallet address" />
          <p className="text-sm leading-relaxed text-ink-2">
            Get testnet USDC at <ExternalLink href={FAUCET}>faucet.circle.com</ExternalLink>: select Arc Testnet, and paste this address.
          </p>
          <BalanceLine orgSlug={orgSlug} />
        </div>
      )}
      <form id="go-live-form" {...formProps} className="grid gap-3 border-t border-line pt-4">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <p className="text-sm leading-relaxed text-ink-2">Going live cannot be undone from here; pausing the agent stops it paying.</p>
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
            description={GO_LIVE_CONSEQUENCES}
            confirmLabel="Go live"
          />
        </div>
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}

function LiveDetails({ orgSlug, status }: { orgSlug: string; status: GoLiveStatus }) {
  return (
    <div className="space-y-3">
      {status.wallets.length > 0 && <WalletList wallets={status.wallets} />}
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

export default function GoLivePanel({ orgSlug, status, canAdminister }: GoLivePanelProps) {
  const live = status.step === "live";

  let body: ReactNode;
  if (status.credentialsUnreadable) {
    body = (
      <Callout tone="refused" title="Circle credentials cannot be read">
        This workspace&apos;s Circle credentials are stored, but this deployment cannot decrypt them, so it pays nothing until they can be read again.
      </Callout>
    );
  } else if (live) {
    body = <LiveDetails orgSlug={orgSlug} status={status} />;
  } else if (!canAdminister) {
    body = <p className="text-sm text-ink-2">An owner can connect Circle and take this workspace live from here.</p>;
  } else if (status.step === "connect") {
    body = <ConnectStep orgSlug={orgSlug} />;
  } else if (status.step === "wallets") {
    body = <WalletsStep orgSlug={orgSlug} status={status} />;
  } else {
    body = <GoLiveStep orgSlug={orgSlug} status={status} />;
  }

  const canReplace = canAdminister && !status.credentialsUnreadable && status.step !== "connect";

  return (
    <section aria-labelledby="go-live-title">
      <SectionHeader id="go-live-title" title="Go live" meta={<StatusLine step={status.step} />} />
      <div className="space-y-4">
        {body}
        {canReplace && <ReplaceCredentials orgSlug={orgSlug} status={status} />}
      </div>
    </section>
  );
}
