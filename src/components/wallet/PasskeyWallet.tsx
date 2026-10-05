"use client";

import { ArrowUpRight, KeyRound, Send, Wallet } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { arcAddressUrl, arcTxUrl } from "@/lib/payee-chains";
import { maskAddress } from "@/lib/payee-journey";
import {
  openPasskeyWallet,
  PASSKEY_WALLET_NETWORK,
  passkeyFailure,
  passkeyWalletConfig,
  sendProblem,
  usdcText,
  usdcUnits,
  type OpenPasskeyWallet,
} from "@/lib/passkey-wallet";

/**
 * A payee's passkey wallet, opened at /wallet (docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md P4):
 * the passkey opens it, it shows its address and USDC on Arc testnet, and it sends USDC after a confirmation that names
 * the destination, the amount, the network and the token. Circle Gas Station pays the gas. Vestiarion records none of
 * it: the wallet is the payee's.
 */

export const OPEN_WALLET = "Open my wallet";

type Screen =
  | { kind: "closed" }
  | { kind: "open" }
  | { kind: "confirm"; to: string; units: bigint }
  | { kind: "sent"; txHash: string; units: bigint; to: string };

export function PasskeyWallet({ configured }: { configured: boolean }) {
  const [wallet, setWallet] = useState<OpenPasskeyWallet | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "closed" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  if (!configured) {
    return (
      <EmptyState
        icon={<Wallet />}
        titleAs="h1"
        title="Passkey wallets are not available here yet."
        body="To be paid, give the business that pays you an address from any wallet on Arc testnet."
      />
    );
  }

  async function refreshBalance(opened: OpenPasskeyWallet) {
    try {
      setBalance(await opened.balance());
    } catch (failure) {
      console.error("passkey wallet balance", failure instanceof Error ? failure.message : failure);
      setBalance(null);
    }
  }

  async function open() {
    const config = passkeyWalletConfig();
    if (!config) return;
    setBusy(true);
    setError("");
    try {
      const { passkeySdk } = await import("@/lib/passkey-wallet-sdk");
      const opened = await openPasskeyWallet({ config, sdk: passkeySdk() });
      setWallet(opened);
      setScreen({ kind: "open" });
      await refreshBalance(opened);
    } catch (failure) {
      setError(passkeyFailure(failure, "open"));
    } finally {
      setBusy(false);
    }
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!wallet) return;
    const problem = sendProblem({ to, amount, balance: balance ?? 0n, from: wallet.address });
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setScreen({ kind: "confirm", to: to.trim(), units: usdcUnits(amount) as bigint });
  }

  async function send(target: string, units: bigint) {
    if (!wallet) return;
    setBusy(true);
    setError("");
    try {
      const txHash = await wallet.send(target, units);
      setScreen({ kind: "sent", txHash, units, to: target });
      setTo("");
      setAmount("");
      await refreshBalance(wallet);
    } catch (failure) {
      setError(passkeyFailure(failure, "send"));
    } finally {
      setBusy(false);
    }
  }

  const network = PASSKEY_WALLET_NETWORK.label;

  return (
    <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Your Vestiarion wallet</h1>
      {screen.kind === "closed" && (
        <div className="mt-3 grid gap-4">
          <p className="text-sm leading-6 text-ink-2">
            The wallet you created from a payment link, on {network}. It opens with the passkey you saved then: your fingerprint, face or device
            PIN.
          </p>
          <Button type="button" icon={<KeyRound />} onClick={open} loading={busy}>
            {OPEN_WALLET}
          </Button>
        </div>
      )}

      {wallet && screen.kind !== "closed" && (
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
          <Row term="Address">
            <a href={arcAddressUrl(wallet.address)} target="_blank" rel="noreferrer" className="font-mono text-agent underline-offset-4 hover:underline">
              {wallet.address}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Row>
          <Row term="USDC">{balance === null ? "Not read yet" : `${usdcText(balance)} USDC on ${network}`}</Row>
        </dl>
      )}

      {wallet && screen.kind === "open" && (
        <form onSubmit={review} noValidate className="mt-6 grid gap-4 border-t border-line pt-5">
          <h2 className="text-base font-semibold text-ink">Send USDC</h2>
          <Field id="wallet-to" label={`To, an address on ${network}`} description="Starts with 0x, then 40 letters and numbers.">
            <Input value={to} onChange={(event) => setTo(event.target.value)} autoComplete="off" spellCheck={false} className="font-mono" placeholder="0x…" />
          </Field>
          <Field id="wallet-amount" label="Amount (USDC)">
            <Input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="1.50" />
          </Field>
          <Button type="submit" variant="secondary" icon={<Send />}>
            Review
          </Button>
        </form>
      )}

      {screen.kind === "confirm" && (
        <div className="mt-6 grid gap-4 border-t border-line pt-5">
          <h2 className="text-base font-semibold text-ink">
            Send {usdcText(screen.units)} USDC to {maskAddress(screen.to)} on {network}?
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
            <Row term="To">
              <span className="font-mono">{screen.to}</span>
            </Row>
            <Row term="Amount">{usdcText(screen.units)} USDC</Row>
            <Row term="Network">{network}</Row>
            <Row term="Gas">Paid by Circle Gas Station</Row>
          </dl>
          <p className="text-xs leading-5 text-ink-3">A send on {network} cannot be taken back. Check the address against where it came from.</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setScreen({ kind: "open" })} disabled={busy}>
              Back
            </Button>
            <Button type="button" icon={<KeyRound />} onClick={() => send(screen.to, screen.units)} loading={busy}>
              Send with my passkey
            </Button>
          </div>
        </div>
      )}

      {screen.kind === "sent" && (
        <div className="mt-6 grid gap-4 border-t border-line pt-5">
          <p role="status" className="text-sm font-medium text-proof">
            Sent {usdcText(screen.units)} USDC to {maskAddress(screen.to)}.
          </p>
          <Button asChild variant="secondary">
            <a href={arcTxUrl(screen.txHash)} target="_blank" rel="noreferrer">
              View the transaction
              <ArrowUpRight aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
          <Button type="button" variant="ghost" onClick={() => setScreen({ kind: "open" })}>
            Send more
          </Button>
        </div>
      )}

      <FormMessage tone="error" className="mt-4">
        {error || null}
      </FormMessage>
      <p className="mt-5 border-t border-line pt-4 text-xs leading-5 text-ink-3">
        This wallet is yours. Vestiarion never sees your passkey and keeps no record of this page.
      </p>
    </section>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{term}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}
