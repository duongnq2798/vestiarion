"use client";

import { ArrowDownToLine, ArrowUpRight, Send, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { connectWallet, discoverWallets, switchChain, walletErrorMessage, type DiscoveredWallet, type Eip1193Provider, type WalletWindow } from "@/lib/browser-wallet";
import {
  forgetInbound,
  formatUsdc,
  inboundArrival,
  InboundError,
  inboundSource,
  inboundSources,
  pendingInbound,
  reviewInbound,
  sendInbound,
  usdcUnits,
  type InboundQuote,
  type PendingInbound,
} from "@/lib/inbound-usdc";
import { networkProfile, type InboundSource, type Network } from "@/lib/network";
import { txUrl } from "@/lib/payee-chains";
import type { SentStore } from "@/lib/treasury/sent-transaction";

/**
 * Add USDC from another chain (docs/superpowers/specs/2026-10-08-add-usdc-from-another-chain-design.md B3–B7): the
 * person's browser wallet burns USDC on another chain through CCTP V2 with the forwarding hook, and Circle mints it on
 * Arc to `recipient`, which needs no gas for it. Folded behind one button until opened; a transfer sent from this browser
 * is followed until Circle mints it, across reloads.
 */

const ARRIVAL_POLL_MS = 5_000;
/** How long a transfer is followed before the person may forget it (B5). */
const FORGET_AFTER_MS = 30 * 60_000;

type Note = { tone: "neutral" | "error"; text: string } | null;
type Review = { provider: Eip1193Provider; from: string; source: InboundSource; balanceUnits: bigint; quote: InboundQuote };

/** Where a transfer is kept until Circle mints it; none where the browser refuses storage. */
function browserStore(): SentStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// What is kept changes from this page (sent, minted, forgotten) or from another tab; both re-read it.
const keptListeners = new Set<() => void>();
function subscribeKept(onChange: () => void): () => void {
  keptListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    keptListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}
const keptChanged = () => keptListeners.forEach((listener) => listener());

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const walletChain = (source: InboundSource) => ({
  chainId: source.chainId,
  label: source.label,
  rpcUrl: source.rpcUrl,
  explorer: source.explorerTx.replace(/\/tx\/$/, ""),
  nativeSymbol: source.nativeSymbol,
});

function TxLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-agent underline-offset-4 hover:underline">
      {children}
      <ArrowUpRight aria-hidden className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export default function AddUsdcFromChain({ network, recipient, recipientLabel }: { network: Network; recipient: string; recipientLabel: string }) {
  const router = useRouter();
  const id = useId();
  const profile = networkProfile(network);
  const sources = inboundSources(profile);
  const [opened, setOpened] = useState(false);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [picked, setPicked] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [arrived, setArrived] = useState<{ pending: PendingInbound; mintTxHash: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  // A transfer this browser sent and has not seen minted (B5): read in the browser only, as the server keeps nothing.
  const keptJson = useSyncExternalStore(subscribeKept, () => JSON.stringify(pendingInbound(browserStore(), profile, recipient)), () => "null");
  const kept = useMemo(() => JSON.parse(keptJson) as PendingInbound | null, [keptJson]);
  const keptSource = kept ? (inboundSources(profile).find((entry) => entry.id === kept.sourceId) ?? null) : null;
  const open = opened || kept !== null || arrived !== null;

  useEffect(() => {
    if (!open || wallets !== null) return;
    let alive = true;
    void discoverWallets(window as unknown as WalletWindow).then((found) => alive && setWallets(found));
    return () => {
      alive = false;
    };
  }, [open, wallets]);

  // Iris is asked every 5 seconds while the page is in view, until it reports the mint.
  useEffect(() => {
    if (!kept || !keptSource) return;
    let alive = true;
    const ask = async () => {
      if (document.visibilityState !== "visible") return;
      const minted = await inboundArrival(profile, keptSource, kept.burnTxHash);
      if (!alive) return;
      if (!minted) {
        setStale(Date.now() - Date.parse(kept.sentAt) > FORGET_AFTER_MS);
        return;
      }
      forgetInbound(browserStore(), profile, recipient);
      keptChanged();
      setArrived({ pending: kept, mintTxHash: minted.mintTxHash });
      router.refresh();
    };
    void ask();
    const timer = window.setInterval(() => void ask(), ARRIVAL_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [kept, keptSource, profile, recipient, router]);

  if (sources.length === 0) return null;

  const run = async (work: (say: (text: string) => void) => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await work((text) => setNote({ tone: "neutral", text }));
    } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      setNote({ tone: "error", text: typeof code === "number" ? walletErrorMessage(error) : error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const check = () =>
    run(async (say) => {
      const source = inboundSource(profile, sourceId);
      const amountUnits = usdcUnits(amount);
      if (amountUnits === null) throw new InboundError("Enter the USDC to send, such as 25 or 12.50, with at most 6 decimals.");
      const wallet = wallets?.[picked];
      if (!wallet) throw new InboundError("No wallet was found in this browser. Install a wallet such as MetaMask or Rabby, then reload the page.");
      say("Connect your wallet…");
      const from = await connectWallet(wallet.provider);
      say(`Switching your wallet to ${source.label}…`);
      await switchChain(wallet.provider, walletChain(source));
      say(`Reading your wallet on ${source.label} and Circle's fee…`);
      const { balanceUnits, quote } = await reviewInbound({ provider: wallet.provider, from, profile, source, amountUnits });
      setNote(null);
      setReview({ provider: wallet.provider, from, source, balanceUnits, quote });
    });

  const send = (current: Review) =>
    run(async (say) => {
      // The wallet may have moved since the review: it is switched back, and asked its chain again before each send.
      await switchChain(current.provider, walletChain(current.source));
      await sendInbound({ provider: current.provider, from: current.from, profile, source: current.source, recipient, quote: current.quote, store: browserStore(), say });
      setNote(null);
      setReview(null);
      setStale(false);
      keptChanged();
    });

  const backToForm = () => {
    setNote(null);
    setReview(null);
  };

  if (!open) {
    return (
      <div>
        <Button type="button" variant="secondary" size="sm" icon={<ArrowDownToLine />} aria-expanded={false} onClick={() => setOpened(true)}>
          Add USDC from another chain
        </Button>
      </div>
    );
  }

  let body: ReactNode;
  if (arrived) {
    body = (
      <>
        <p className="text-sm leading-relaxed text-ink-2">
          Arrived: Circle minted the USDC to {recipientLabel} on {profile.label} (<TxLink href={txUrl(network, arrived.mintTxHash)}>see it on {profile.label}</TxLink>).
        </p>
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setArrived(null);
              setAmount("");
              backToForm();
            }}
          >
            Add more
          </Button>
        </div>
      </>
    );
  } else if (kept) {
    body = (
      <>
        <p className="text-sm leading-relaxed text-ink-2">
          On its way: you sent {formatUsdc(BigInt(kept.amountUnits))} USDC from {keptSource?.label ?? kept.sourceId}
          {keptSource && (
            <>
              {" "}
              (<TxLink href={`${keptSource.explorerTx}${kept.burnTxHash}`}>see it on {keptSource.label}</TxLink>)
            </>
          )}
          . Circle mints it to {recipientLabel} on {profile.label}, usually within a minute. This page checks every 5 seconds.
        </p>
        {(stale || !keptSource) && (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-ink-3">
              {keptSource
                ? "Circle has not minted it after 30 minutes. If your wallet shows the transfer failed, forget it here; nothing is sent again."
                : `This page no longer follows transfers from ${kept.sourceId}. Forget it here; nothing is sent again.`}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                forgetInbound(browserStore(), profile, recipient);
                setStale(false);
                keptChanged();
              }}
            >
              Forget this transfer
            </Button>
          </div>
        )}
      </>
    );
  } else if (review) {
    const { source, quote } = review;
    const rows: Array<[string, ReactNode]> = [
      ["From", `Your wallet ${short(review.from)} on ${source.label}, which holds ${formatUsdc(review.balanceUnits)} USDC there`],
      ["To", `${recipientLabel} ${short(recipient)} on ${profile.label}`],
      ["Circle's fee", `At most ${formatUsdc(quote.maxFeeUnits)} USDC`],
      ["Arrives", `At least ${formatUsdc(quote.arrivesUnits)} USDC, usually within a minute`],
    ];
    body = (
      <>
        <dl className="grid items-baseline gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-3">{label}</dt>
              <dd className="min-w-0 break-words text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs leading-relaxed text-ink-3">
          Your wallet asks you to approve the transfer, unless you approved enough before, then to send it. It pays {source.label}&apos;s gas in{" "}
          {source.nativeSymbol}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" icon={<Send />} loading={busy} onClick={() => void send(review)}>
            Send {formatUsdc(quote.amountUnits)} USDC from {source.label}
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={backToForm}>
            Change
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-source`} label="From">
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id={`${id}-amount`} label="Amount (USDC)">
            <Input inputMode="decimal" autoComplete="off" placeholder="25.00" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
        </div>
        {wallets && wallets.length > 1 && (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Choose a wallet">
            {wallets.map((wallet, index) => (
              <Button key={wallet.id} type="button" size="sm" variant={index === picked ? "primary" : "secondary"} onClick={() => setPicked(index)} aria-pressed={index === picked}>
                {wallet.name}
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" icon={<Wallet />} loading={busy} disabled={wallets === null} onClick={() => void check()}>
            Review
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpened(false)}>
            Cancel
          </Button>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-xl border border-line p-4">
      <div className="space-y-1">
        <h4 id={`${id}-title`} className="text-sm font-semibold text-ink">
          Add USDC from another chain
        </h4>
        <p className="text-sm leading-relaxed text-ink-2">
          Send USDC your wallet holds on another chain, such as {sources[0].label} or {sources[1]?.label ?? sources[0].label}, to {recipientLabel} on{" "}
          {profile.label}. Circle&apos;s CCTP burns it there and mints it on {profile.label} itself, so {recipientLabel} needs no gas for it. Your wallet pays the
          other chain&apos;s gas in its own currency, such as {sources[0].nativeSymbol} on {sources[0].label}.
        </p>
      </div>
      {body}
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </section>
  );
}
