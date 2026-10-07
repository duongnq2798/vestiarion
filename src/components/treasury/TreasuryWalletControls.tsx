"use client";

import { Ban, KeyRound, Play, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Hex } from "viem";
import { recordWalletControlAction } from "@/app/actions/wallet-treasury";
import { openTreasury } from "@/components/treasury/PasskeyTreasurySteps";
import { useOwnerWallet, WalletPicker } from "@/components/treasury/WalletTreasurySteps";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { sendPrepared, walletErrorMessage } from "@/lib/browser-wallet";
import { networkProfile, type Network } from "@/lib/network";
import { PasskeyTreasuryError, passkeyTreasuryFailure, pollRecord } from "@/lib/passkey-treasury";
import { figuresCall, resumeCall, stopCall, WalletControlError, type ControlCall } from "@/lib/treasury/wallet-controls";
import type { WalletControlKind, WalletTreasuryStatus } from "@/lib/treasury/wallet-treasury";

/**
 * A live treasury's own wallet controls its contract (docs/superpowers/specs/2026-10-07-treasury-wallet-controls-design.md
 * C1–C4): the figures, prefilled from what the contract holds, and stopping or resuming the agent's payments. The call is
 * built here from what the panel shows, the treasury's own signer sends it (a passkey's user operation, or the browser
 * wallet's transaction), and it is recorded once the chain shows it.
 */

const POLL_TRIES = 12;
const POLL_MS = 5_000;

type Note = { tone: "neutral" | "error"; text: string } | null;

const DONE: Record<WalletControlKind, string> = {
  figures: "The contract holds the new figures, and the agent's spending limit follows them.",
  stop: "Stopped: the agent can pay nothing through the contract, and it is paused.",
  resume: "Resumed: the agent pays through the contract again.",
};

function failure(error: unknown, passkey: boolean): string {
  if (error instanceof WalletControlError || error instanceof PasskeyTreasuryError) return error.message;
  if (passkey) return passkeyTreasuryFailure(error, "control");
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" ? walletErrorMessage(error) : error instanceof Error ? error.message : String(error);
}

const typedFigure = (usdc: number | null) => (usdc === null ? "" : String(usdc));

export default function TreasuryWalletControls({ orgSlug, status, network }: { orgSlug: string; status: WalletTreasuryStatus; network: Network }) {
  const router = useRouter();
  const profile = networkProfile(network);
  const owner = useOwnerWallet(network);
  const [daily, setDaily] = useState(typedFigure(status.dailyUsdc));
  const [weekly, setWeekly] = useState(typedFigure(status.weeklyUsdc));
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState<WalletControlKind | null>(null);
  const [note, setNote] = useState<Note>(null);
  if (!status.wallet || !status.contract) return null;
  const wallet = status.wallet as Hex;
  const contract = status.contract as Hex;
  const usdc = profile.tokens.USDC as Hex;
  const passkey = status.signer === "passkey";

  const run = async (kind: WalletControlKind, build: () => ControlCall) => {
    setBusy(kind);
    setNote(null);
    const say = (text: string) => setNote({ tone: "neutral", text });
    try {
      const call = build();
      let hash: string;
      if (passkey) {
        const treasury = await openTreasury(orgSlug, wallet, say);
        say("Confirm with your passkey.");
        const outcome = await treasury.send([{ to: call.to, data: call.data, value: call.value }]);
        if (outcome.kind === "reverted") throw new PasskeyTreasuryError(`${profile.label} did not carry it out; only its network fee was spent.`);
        if (outcome.kind === "unconfirmed") {
          say(`Sent. ${profile.label} has not confirmed it yet; reload this page in a minute.`);
          return;
        }
        hash = outcome.txHash;
      } else {
        const { provider, address } = await owner.open(wallet);
        say("Confirm in your wallet.");
        hash = await sendPrepared(provider, address, { to: call.to, data: call.data, value: "0", chainId: profile.chainId });
      }
      say(`Sent. Waiting for ${profile.label} to confirm it…`);
      const polled = await pollRecord({ record: () => recordWalletControlAction(orgSlug, { txHash: hash, kind }), tries: POLL_TRIES, waitMs: POLL_MS });
      if (polled.state === "refused") throw new PasskeyTreasuryError(polled.message);
      if (polled.state === "unread") {
        say(`Sent. ${profile.label} has not confirmed it yet; reload this page in a minute.`);
        return;
      }
      setNote({ tone: "neutral", text: DONE[kind] });
      router.refresh();
    } catch (error) {
      setNote({ tone: "error", text: failure(error, passkey) });
    } finally {
      setBusy(null);
    }
  };

  const approval =
    status.approval === "unlimited"
      ? "The contract may move your USDC without a cap."
      : typeof status.approval === "number"
        ? `The contract may move up to ${status.approval} USDC of yours.`
        : null;

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">Change what the agent may pay</h3>
        <p className="text-sm leading-relaxed text-ink-2">
          Your wallet sets these figures on its contract, and the agent&apos;s spending limit follows them. The network fee is paid from your
          wallet&apos;s USDC.
        </p>
        {!passkey && <WalletPicker wallets={owner.wallets} picked={owner.picked} onPick={owner.setPicked} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="treasury-controls-daily" label="Daily figure (USDC)">
            <Input id="treasury-controls-daily" inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} />
          </Field>
          <Field id="treasury-controls-weekly" label="7-day figure (USDC)">
            <Input id="treasury-controls-weekly" inputMode="decimal" value={weekly} onChange={(event) => setWeekly(event.target.value)} />
          </Field>
        </div>
        <div>
          <Button
            type="button"
            icon={passkey ? <KeyRound /> : <Wallet />}
            loading={busy === "figures"}
            disabled={busy !== null}
            onClick={() => run("figures", () => figuresCall({ contract, daily, weekly }))}
          >
            {passkey ? "Change with your passkey" : "Change from your wallet"}
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        {status.approval === "stopped" ? (
          <>
            <p className="text-sm leading-relaxed text-ink-2">Stopped: the contract may move none of your USDC, and the agent is paused.</p>
            <Field id="treasury-controls-cap" label="Cap (USDC)" description="Empty resumes without a cap; the figures still bound each day and 7 days." optional>
              <Input id="treasury-controls-cap" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
            </Field>
            <div>
              <Button type="button" icon={<Play />} loading={busy === "resume"} disabled={busy !== null} onClick={() => run("resume", () => resumeCall({ usdc, contract, cap }))}>
                Resume payments
              </Button>
            </div>
          </>
        ) : (
          <>
            {approval && <p className="text-sm leading-relaxed text-ink-2">{approval}</p>}
            <div>
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="secondary" icon={<Ban />} loading={busy === "stop"} disabled={busy !== null}>
                    Stop the agent&apos;s payments
                  </Button>
                }
                title="Stop the agent's payments?"
                description="Your wallet sets the contract's approval to 0, so the agent can pay nothing through it, and the agent is paused. You can resume here at any time."
                confirmLabel="Stop payments"
                onConfirm={() => run("stop", () => stopCall({ usdc, contract }))}
              />
            </div>
          </>
        )}
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </div>
  );
}
