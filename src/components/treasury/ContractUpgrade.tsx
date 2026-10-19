"use client";

import { ArrowUpCircle, KeyRound, RefreshCw, ShieldOff, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { preparePasskeyUpgradeAction, prepareUpgradeAction, recordPasskeyUpgradeAction, recordUpgradeAction } from "@/app/actions/wallet-treasury";
import { openTreasury } from "@/components/treasury/PasskeyTreasurySteps";
import { useOwnerWallet, WalletAddress, WalletPicker } from "@/components/treasury/WalletTreasurySteps";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { sendPrepared, walletErrorMessage } from "@/lib/browser-wallet";
import { ARC_MAINNET, networkProfile, type Network } from "@/lib/network";
import { browserKeepingStore, checkPasskeySetup, passkeyTreasuryFailure, PasskeyTreasuryError, passkeyUpgradeCalls, pollRecord } from "@/lib/passkey-treasury";
import type { SendOutcome } from "@/lib/passkey-wallet-send";
import { spendingLimitTerms } from "@/lib/spending-limit/deployment";
import { forgetSent, recordSent, rememberSent, sentHash, type SentStep } from "@/lib/treasury/sent-transaction";
import { stopCall } from "@/lib/treasury/wallet-controls";
import type { WalletTreasuryStatus } from "@/lib/treasury/wallet-treasury";
import { figureUnits } from "@/lib/usdc-figure";

/**
 * The upgrade of a workspace's spending limit contract to version 2, which also pays a vendor on another chain through
 * CCTP (docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-chain-design.md V10). A browser wallet deploys version
 * 2, approves it and takes version 1's approval back, one transaction each; a passkey does all of it with one
 * confirmation, built here again from what the panel shows and checked against what the server built. Each result is
 * recorded once the chain shows it, and kept in this browser until then, so a reload asks again rather than sends again.
 *
 * Its parent keeps it mounted whatever the status says: a recorded step re-renders the page with the next status, and
 * the line saying what was done lives here, in state the new status does not unmount (the revalidate unmount pattern).
 */

const POLL_TRIES = 24;
const POLL_MS = 5_000;
/** A passkey's upgrade kept until it is recorded: its transaction or user operation, and the contract it deploys. */
const keptKey = (orgSlug: string) => `vestiarion.wallet-treasury.${orgSlug}.upgrade-passkey`;

type Note = { tone: "neutral" | "error"; text: string } | null;
type KeptPasskeyUpgrade = { contract: Hex; txHash?: Hex; userOpHash?: Hex };

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function keptPasskeyUpgrade(orgSlug: string): KeptPasskeyUpgrade | null {
  try {
    const value = JSON.parse(browserKeepingStore()?.getItem(keptKey(orgSlug)) ?? "null") as Partial<KeptPasskeyUpgrade> | null;
    if (!value || typeof value.contract !== "string" || !ADDRESS.test(value.contract)) return null;
    const txHash = typeof value.txHash === "string" && HASH.test(value.txHash) ? value.txHash : undefined;
    const userOpHash = typeof value.userOpHash === "string" && HASH.test(value.userOpHash) ? value.userOpHash : undefined;
    return txHash || userOpHash ? { contract: value.contract, ...(txHash ? { txHash } : {}), ...(userOpHash ? { userOpHash } : {}) } : null;
  } catch {
    return null;
  }
}

function keepPasskeyUpgrade(orgSlug: string, kept: KeptPasskeyUpgrade | null): void {
  try {
    if (kept) browserKeepingStore()?.setItem(keptKey(orgSlug), JSON.stringify(kept));
    else browserKeepingStore()?.removeItem(keptKey(orgSlug));
  } catch {
    // A private window or full storage: only a reload loses it.
  }
}

function sentStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const STEP_OF = { offer: "upgrade-deploy", approve: "upgrade-approve", revoke: "upgrade-revoke" } as const satisfies Record<string, SentStep>;
const ACTION_STEP = { "upgrade-deploy": "deploy", "upgrade-approve": "approve", "upgrade-revoke": "revoke" } as const;

const DONE = {
  "upgrade-deploy": "The new contract is deployed. Approve it next.",
  "upgrade-approve": "The new contract carries the agent's payments now, to other chains too. Take the old contract's approval back next.",
  "upgrade-revoke": "Done: the old contract can move none of your USDC.",
  passkey: "Upgraded: the new contract carries the agent's payments, to other chains too, and the old one can move none of your USDC.",
} as const;

function failure(error: unknown, passkey: boolean): string {
  if (error instanceof PasskeyTreasuryError) return error.message;
  if (passkey) return passkeyTreasuryFailure(error, "control");
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" ? walletErrorMessage(error) : error instanceof Error ? error.message : String(error);
}

/** The cap typed, in USDC: empty is none. */
function typedCap(cap: string): number | null {
  const read = figureUnits(cap, "cap");
  if (!read.ok) throw new PasskeyTreasuryError("Give the cap in USDC, above 0, or leave it empty.");
  return read.units === null ? null : Number(read.units) / 1_000_000;
}

const unitsOf = (usdc: number | null) => (usdc === null ? 0n : BigInt(Math.round(usdc * 1_000_000)));

export default function ContractUpgrade({ orgSlug, status, network }: { orgSlug: string; status: WalletTreasuryStatus; network: Network }) {
  const router = useRouter();
  const profile = networkProfile(network);
  const owner = useOwnerWallet(network);
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [kept, setKept] = useState<KeptPasskeyUpgrade | null>(null);
  const passkey = status.signer === "passkey";
  const upgrade = status.upgrade;
  const say = (text: string) => setNote({ tone: "neutral", text });

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await work();
    } catch (error) {
      setNote({ tone: "error", text: failure(error, passkey) });
    } finally {
      setBusy(false);
    }
  };

  /** Asks the server to record a passkey's upgrade until the chain shows it; kept until then, forgotten once answered. */
  const settlePasskey = async (contract: Hex, outcome: SendOutcome) => {
    if (outcome.kind === "reverted") {
      keepPasskeyUpgrade(orgSlug, null);
      throw new PasskeyTreasuryError(`${profile.label} did not carry out the upgrade; only its network fee was spent.`);
    }
    const stillChecking = `Sent. ${profile.label} has not confirmed it yet; check again in a minute. It is not sent twice.`;
    if (outcome.kind === "unconfirmed") {
      const pending = { contract, userOpHash: outcome.userOpHash as Hex };
      keepPasskeyUpgrade(orgSlug, pending);
      setKept(pending);
      say(stillChecking);
      return;
    }
    const pending = { contract, txHash: outcome.txHash as Hex };
    keepPasskeyUpgrade(orgSlug, pending);
    setKept(pending);
    say(`Sent. Waiting for ${profile.label} to confirm it…`);
    const polled = await pollRecord({ record: () => recordPasskeyUpgradeAction(orgSlug, { txHash: outcome.txHash, contract }), tries: POLL_TRIES, waitMs: POLL_MS });
    if (polled.state === "verified") {
      keepPasskeyUpgrade(orgSlug, null);
      setKept(null);
      setNote({ tone: "neutral", text: DONE.passkey });
      router.refresh();
      return;
    }
    if (polled.state === "refused") {
      keepPasskeyUpgrade(orgSlug, null);
      setKept(null);
      throw new PasskeyTreasuryError(polled.message);
    }
    say(stillChecking);
  };

  /** A browser wallet's step: built by the server, sent from the wallet, recorded once the chain shows it. */
  const sendStep = (step: SentStep & keyof typeof ACTION_STEP) =>
    run(async () => {
      const capUsdc = step === "upgrade-approve" ? typedCap(cap) : null;
      const { provider, address } = await owner.open(status.wallet);
      const prepared = await prepareUpgradeAction(orgSlug, { step: ACTION_STEP[step], capUsdc });
      if (!prepared.ok || !prepared.transaction) throw new Error(prepared.message);
      say("Confirm it in your wallet.");
      const hash = await sendPrepared(provider, address, prepared.transaction);
      await recordStep(step, hash, POLL_TRIES);
    });

  const recordStep = async (step: SentStep & keyof typeof ACTION_STEP, hash: string, tries: number) => {
    const store = sentStore();
    rememberSent(store, orgSlug, step, hash);
    say(`Sent. Waiting for ${profile.label} to confirm it…`);
    const outcome = await recordSent({ store, orgSlug, step, hash, record: (txHash) => recordUpgradeAction(orgSlug, { step: ACTION_STEP[step], txHash }), tries, waitMs: POLL_MS });
    if (outcome === "verified") {
      setNote({ tone: "neutral", text: DONE[step] });
      router.refresh();
    } else {
      say(`${profile.label} has not confirmed it yet. Reload this page to check again; it is not sent twice.`);
    }
  };

  const upgradeWithPasskey = () =>
    run(async () => {
      if (!status.wallet || !status.agent || !status.contract) return;
      const capUsdc = typedCap(cap);
      const prepared = await preparePasskeyUpgradeAction(orgSlug, { capUsdc });
      if (!prepared.ok || !prepared.upgrade) throw new PasskeyTreasuryError(prepared.message);
      const server = prepared.upgrade;
      const terms = spendingLimitTerms(ARC_MAINNET);
      if (!terms) throw new PasskeyTreasuryError("Arc mainnet has no CCTP to pay other chains through.");
      // The browser's own upgrade, from what the panel shows: anything else is refused before the passkey is asked.
      const expected = passkeyUpgradeCalls({
        usdc: ARC_MAINNET.tokens.USDC,
        treasury: status.wallet,
        agent: status.agent,
        dailyUnits: unitsOf(status.dailyUsdc),
        weeklyUnits: unitsOf(status.weeklyUsdc),
        capUnits: capUsdc === null ? null : unitsOf(capUsdc),
        salt: server.salt,
        deployed: server.deployed,
        terms,
        previous: status.contract,
      });
      checkPasskeySetup(server, expected);
      const treasury = await openTreasury(orgSlug, status.wallet, say);
      say("Confirm the upgrade with your passkey.");
      await settlePasskey(expected.contract, await treasury.send(expected.calls));
    });

  /** A passkey wallet's revocation of the old contract, where its upgrade left it approved: approve it for 0 USDC. */
  const revokeWithPasskey = () =>
    run(async () => {
      if (!status.wallet || !upgrade?.previous) return;
      const call = stopCall({ usdc: profile.tokens.USDC as Hex, contract: upgrade.previous as Hex });
      const treasury = await openTreasury(orgSlug, status.wallet, say);
      say("Confirm with your passkey.");
      const outcome = await treasury.send([call]);
      if (outcome.kind === "reverted") throw new PasskeyTreasuryError(`${profile.label} did not carry it out; only its network fee was spent.`);
      if (outcome.kind === "unconfirmed") {
        say(`Sent. ${profile.label} has not confirmed it yet; reload this page in a minute.`);
        return;
      }
      await recordStep("upgrade-revoke", outcome.txHash, POLL_TRIES);
    });

  /** What this browser sent before: asked about again, never sent again. */
  const checkAgain = () =>
    run(async () => {
      const passkeyKept = keptPasskeyUpgrade(orgSlug);
      if (passkey && passkeyKept && status.wallet) {
        say("Checking the upgrade your passkey sent…");
        const outcome: SendOutcome = passkeyKept.txHash
          ? { kind: "sent", txHash: passkeyKept.txHash }
          : await (await openTreasury(orgSlug, status.wallet, say)).receipt(passkeyKept.userOpHash as Hex);
        await settlePasskey(passkeyKept.contract, outcome);
        return;
      }
      if (!upgrade) return;
      const step = STEP_OF[upgrade.state];
      const hash = sentHash(sentStore(), orgSlug, step);
      if (hash) {
        say("Checking the transaction your wallet sent…");
        await recordStep(step, hash, 1);
      }
    });

  // A step sent before the page was reloaded is asked about again once, after it has painted; steps behind are forgotten.
  useEffect(() => {
    const soon = setTimeout(() => {
      const passkeyKept = keptPasskeyUpgrade(orgSlug);
      setKept(passkeyKept);
      const store = sentStore();
      const current = upgrade ? STEP_OF[upgrade.state] : null;
      for (const step of Object.values(STEP_OF)) if (step !== current) forgetSent(store, orgSlug, step);
      if (passkeyKept || (current && sentHash(store, orgSlug, current))) void checkAgain();
    }, 0);
    return () => clearTimeout(soon);
    // Once for each step the page opens on: what is kept is read as it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, upgrade?.state]);

  if (!status.wallet || !status.contract || (!upgrade && !note)) return null;

  let body = null;
  if (upgrade && passkey && upgrade.state === "offer") {
    body = (
      <>
        <p className="text-sm leading-relaxed text-ink-2">Your passkey confirms once, and your wallet:</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
          <li>deploys the new contract, with the figures your contract holds now;</li>
          <li>approves it to move your USDC{cap.trim() ? `, up to ${cap.trim()} USDC` : ""};</li>
          <li>takes the old contract&apos;s approval back, so it can move none of your USDC.</li>
        </ol>
        <Field id="contract-upgrade-cap" label="Cap (USDC)" description="Empty approves without a cap; the figures still bound each day and 7 days." optional>
          <Input id="contract-upgrade-cap" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
        </Field>
        <div>
          <Button type="button" icon={<KeyRound />} loading={busy} disabled={busy || kept !== null} onClick={() => void upgradeWithPasskey()}>
            Upgrade with your passkey
          </Button>
        </div>
      </>
    );
  } else if (upgrade?.state === "offer") {
    body = (
      <>
        <p className="text-sm leading-relaxed text-ink-2">
          Step 1 of 3: your wallet deploys the new contract, with the figures your contract holds now. It costs a little USDC of gas on {profile.label}.
        </p>
        <div>
          <Button type="button" icon={<Wallet />} loading={busy} disabled={busy || owner.wallets === null} onClick={() => void sendStep("upgrade-deploy")}>
            Deploy the new contract
          </Button>
        </div>
      </>
    );
  } else if (upgrade?.state === "approve") {
    body = (
      <>
        {upgrade.next && <WalletAddress value={upgrade.next} label="Copy the new contract's address" />}
        <p className="text-sm leading-relaxed text-ink-2">
          Step 2 of 3: your wallet lets the new contract move its USDC. From then on it carries the agent&apos;s payments, within the same figures.
        </p>
        <Field id="contract-upgrade-cap" label="Cap (USDC)" description="Empty approves without a cap; the figures still bound each day and 7 days." optional>
          <Input id="contract-upgrade-cap" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
        </Field>
        <div>
          <Button type="button" icon={<ArrowUpCircle />} loading={busy} disabled={busy || owner.wallets === null} onClick={() => void sendStep("upgrade-approve")}>
            Approve the new contract
          </Button>
        </div>
      </>
    );
  } else if (upgrade?.state === "revoke") {
    body = (
      <>
        {upgrade.previous && <WalletAddress value={upgrade.previous} label="Copy the old contract's address" />}
        <p className="text-sm leading-relaxed text-ink-2">
          {passkey ? "" : "Step 3 of 3: "}The agent pays through the new contract now, but the old one is still approved to move your USDC. Take that approval back.
        </p>
        <div>
          <Button
            type="button"
            icon={<ShieldOff />}
            loading={busy}
            disabled={busy || (!passkey && owner.wallets === null)}
            onClick={() => void (passkey ? revokeWithPasskey() : sendStep("upgrade-revoke"))}
          >
            {passkey ? "Revoke with your passkey" : "Revoke the old contract"}
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="space-y-3 border-t border-line pt-4">
      {upgrade && (
        <>
          <h3 className="text-sm font-semibold text-ink">{upgrade.state === "revoke" ? "Finish the upgrade" : "Pay vendors on other chains"}</h3>
          {upgrade.state !== "revoke" && (
            <p className="text-sm leading-relaxed text-ink-2">
              Your contract pays on {profile.label} only. The new version also pays a vendor on Base through CCTP, from your wallet, within the same daily and
              7-day figures, the CCTP fee included. The contract is not audited.
            </p>
          )}
          {!passkey && <WalletPicker wallets={owner.wallets} picked={owner.picked} onPick={owner.setPicked} />}
          {body}
          {kept && (
            <div>
              <Button type="button" variant="secondary" size="sm" icon={<RefreshCw />} loading={busy} disabled={busy} onClick={() => void checkAgain()}>
                Check again
              </Button>
            </div>
          )}
        </>
      )}
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </div>
  );
}
