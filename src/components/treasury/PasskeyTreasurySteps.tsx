"use client";

import { KeyRound, ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { parseEther, type Hex } from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import {
  choosePasskeyTreasuryAction,
  createAgentWalletAction,
  prepareAgentGasAction,
  preparePasskeySetupAction,
  recordPasskeySetupAction,
  recordRecoveryAction,
  skipRecoveryAction,
} from "@/app/actions/wallet-treasury";
import { WalletTreasurySummary } from "@/components/treasury/WalletTreasurySteps";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import { ARC_MAINNET, networkProfile, type Network } from "@/lib/network";
import {
  browserKeepingStore,
  checkPasskeySetup,
  forgetCredential,
  forgetPendingSetup,
  keepCredential,
  keepPendingSetup,
  keptCredential,
  openPasskeyTreasury,
  passkeySetupCalls,
  passkeyTreasuryConfig,
  passkeyTreasuryFailure,
  PasskeyTreasuryError,
  pendingSetup,
  SETUP_MISMATCH,
  type PasskeyTreasury,
} from "@/lib/passkey-treasury";
import { passkeyMark, passkeyName } from "@/lib/passkey-wallet";
import type { SendOutcome } from "@/lib/passkey-wallet-send";
import { recordSent } from "@/lib/treasury/sent-transaction";
import type { WalletTreasuryStatus } from "@/lib/treasury/wallet-treasury";

/**
 * Go live's passkey route (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md K5–K10): the owner's passkey
 * wallet funded, set up with one confirmation, and its recovery registered or skipped. The server builds what the
 * passkey signs; the browser builds it again and refuses anything else, since a passkey prompt shows no transaction.
 */

const POLL_MS = 5_000;
const POLL_TRIES = 24;
const FUND_POLL_MS = 10_000;
const AGENT_GAS_WEI = parseEther("0.5");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Note = { tone: "neutral" | "error"; text: string } | null;
type During = "create" | "open" | "setup" | "recovery";

const keepingStore = browserKeepingStore;

/** What a person typed as USDC: empty is "not set". */
const typed = (value: string): number | null => (value.trim() === "" ? null : Number(value));
/** USDC in its 6-decimal units, rounded once, as the server rounds them. */
const unitsOf = (usdc: number) => BigInt(Math.round(usdc * 1_000_000));
const figureText = (units: string) => (units === "0" ? "no limit" : `${Number(units) / 1_000_000} USDC`);

/** Runs a step and says how it went; a failure in plain words (K10). */
function usePasskeyStep(during: During) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const run = async (work: (say: (text: string) => void) => Promise<void>, as: During = during) => {
    setBusy(true);
    setNote(null);
    try {
      await work((text) => setNote({ tone: "neutral", text }));
    } catch (error) {
      setNote({ tone: "error", text: passkeyTreasuryFailure(error, as) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, run };
}

const neverChanges = () => () => {};

/** Whether a passkey wallet can work here (K1): the browser has WebAuthn, and the deployment the mainnet client key. */
export function usePasskeysAvailable(): boolean {
  const webauthn = useSyncExternalStore(neverChanges, () => typeof window.PublicKeyCredential !== "undefined", () => true);
  return webauthn && passkeyTreasuryConfig() !== null;
}

/**
 * Go live's passkey card (K1, K3): a new passkey and the wallet it owns, or one made before; either becomes the
 * treasury by its address, and the agent's wallet is made with it.
 */
export function PasskeyWalletCard({ orgSlug, lead }: { orgSlug: string; lead: boolean }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("create");
  const choose = (mode: "Register" | "Login") =>
    run(
      async (say) => {
        const config = passkeyTreasuryConfig();
        if (!config) throw new PasskeyTreasuryError("Passkey wallets are not set up on this deployment.");
        const { passkeySdk } = await import("@/lib/passkey-wallet-sdk");
        say(mode === "Register" ? "Create the passkey when your browser asks." : "Choose the passkey you made for this workspace.");
        const treasury = await openPasskeyTreasury({
          config,
          sdk: passkeySdk(ARC_MAINNET),
          mode,
          ...(mode === "Register" ? { username: passkeyName(orgSlug, passkeyMark()) } : {}),
        });
        keepCredential(keepingStore(), orgSlug, treasury.credential);
        const chosen = await choosePasskeyTreasuryAction(orgSlug, treasury.address);
        if (!chosen.ok) throw new PasskeyTreasuryError(chosen.message);
        say(chosen.message);
        router.refresh();
      },
      mode === "Register" ? "create" : "open"
    );
  return (
    <div className={cn("space-y-3 rounded-xl border p-4", lead ? "border-agent-line bg-agent-soft/40" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">Create a wallet with a passkey</h4>
        <Badge tone={lead ? "agent" : "neutral"} size="sm">
          {lead ? "Recommended" : "No app needed"}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed text-ink-2">
        Your face, fingerprint or device PIN signs for the wallet: Face ID, Touch ID, Windows Hello, or your phone. No extension to install and no seed
        phrase to type. The treasury stays yours: Vestiarion never holds your USDC, and one confirmation sets it all up.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" icon={<KeyRound />} variant={lead ? "primary" : "secondary"} loading={busy} onClick={() => choose("Register")}>
          Create with a passkey
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => choose("Login")}>
          Use a passkey you made before
        </Button>
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </div>
  );
}

/**
 * The treasury's passkey wallet: with the passkey this browser kept, without a prompt until it signs, or the one the
 * owner picks. A passkey owning another wallet is refused by name (Review Focus 3); a kept one that does is forgotten.
 */
async function openTreasury(orgSlug: string, expected: string, say: (text: string) => void): Promise<PasskeyTreasury> {
  const config = passkeyTreasuryConfig();
  if (!config) throw new PasskeyTreasuryError("Passkey wallets are not set up on this deployment.");
  const { passkeySdk } = await import("@/lib/passkey-wallet-sdk");
  const sdk = passkeySdk(ARC_MAINNET);
  const store = keepingStore();
  const kept = keptCredential(store, orgSlug);
  let treasury: PasskeyTreasury | null = null;
  if (kept) {
    try {
      treasury = await openPasskeyTreasury({ config, sdk, mode: "Kept", kept, expected });
    } catch (error) {
      if (!(error instanceof PasskeyTreasuryError)) throw error;
      forgetCredential(store, orgSlug);
    }
  }
  if (!treasury) {
    say("Choose the passkey you made for this wallet.");
    treasury = await openPasskeyTreasury({ config, sdk, mode: "Login", expected });
  }
  if (treasury.credential) keepCredential(store, orgSlug, treasury.credential);
  return treasury;
}

/** Ends a setup the passkey sent (K7, K10): recorded once the chain shows it, kept until then, never sent again blind. */
async function settleSetup(orgSlug: string, contract: Hex, outcome: SendOutcome, say: (text: string) => void, label: string): Promise<boolean> {
  const store = keepingStore();
  if (outcome.kind === "reverted") {
    forgetPendingSetup(store, orgSlug);
    throw new PasskeyTreasuryError(`${label} refused the setup; nothing moved. Try again in a moment.`);
  }
  if (outcome.kind === "unconfirmed") {
    keepPendingSetup(store, orgSlug, { contract, userOpHash: outcome.userOpHash as Hex });
    say(`Sent. ${label} has not confirmed it yet; reload this page in a minute to check again.`);
    return false;
  }
  keepPendingSetup(store, orgSlug, { contract, txHash: outcome.txHash as Hex });
  say(`Sent. Waiting for ${label} to confirm it…`);
  const recorded = await recordSent({
    store,
    orgSlug,
    step: "deploy",
    hash: outcome.txHash,
    record: (hash) => recordPasskeySetupAction(orgSlug, { txHash: hash, contract }),
    tries: POLL_TRIES,
    waitMs: POLL_MS,
  });
  if (recorded === "verified") {
    forgetPendingSetup(store, orgSlug);
    return true;
  }
  say(`${label} has not confirmed it yet. Reload this page to check again; it is not sent twice.`);
  return false;
}

function AgentStep({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("setup");
  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Create the agent&apos;s wallet</h3>
      <p className="text-sm leading-relaxed text-ink-2">
        Vestiarion creates a wallet, in its own Circle account, that pays through your contract. It holds only gas, never your USDC.
      </p>
      <div>
        <Button
          type="button"
          icon={<ShieldCheck />}
          loading={busy}
          onClick={() =>
            run(async () => {
              const created = await createAgentWalletAction(orgSlug);
              if (!created.ok) throw new PasskeyTreasuryError(created.message);
              router.refresh();
            })
          }
        >
          Create the agent&apos;s wallet
        </Button>
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </>
  );
}

/** Below what setup needs (K5): the wallet's address, and the page reading its USDC again by itself. */
function FundStep({ status, label }: { status: WalletTreasuryStatus; label: string }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, FUND_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Add USDC to your wallet</h3>
      <p className="text-sm leading-relaxed text-ink-2">
        Send USDC on {label} to your wallet&apos;s address above, from an exchange or another wallet. Setup needs about {status.setupNeedsUsdc.toFixed(2)} USDC: 0.50 for the
        agent&apos;s gas and about 0.05 for the network fee. Add what the workspace will pay on top.
      </p>
      <p className="text-xs text-ink-3">This page checks for it every 10 seconds.</p>
      <div>
        <Button type="button" variant="secondary" size="sm" onClick={() => router.refresh()}>
          Refresh
        </Button>
      </div>
    </>
  );
}

/** One confirmation sets everything up (K6): built by the server, built again here, then signed. */
function SetupStep({ orgSlug, status, label }: { orgSlug: string; status: WalletTreasuryStatus; label: string }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("setup");
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [cap, setCap] = useState("");
  const capTyped = typed(cap);

  // A setup sent before this page loaded is asked about, never sent again blind (K10).
  useEffect(() => {
    const store = keepingStore();
    const pending = pendingSetup(store, orgSlug);
    if (!pending || !status.wallet) return;
    const wallet = status.wallet;
    void run(async (say) => {
      say("Checking the setup your passkey sent…");
      let outcome: SendOutcome;
      if (pending.txHash) {
        outcome = { kind: "sent", txHash: pending.txHash };
      } else if (pending.userOpHash && keptCredential(store, orgSlug)) {
        outcome = await (await openTreasury(orgSlug, wallet, say)).receipt(pending.userOpHash);
      } else {
        say(`A setup was sent from this browser and ${label} has not confirmed it yet. Reload this page in a minute.`);
        return;
      }
      if (await settleSetup(orgSlug, pending.contract, outcome, say, label)) router.refresh();
    });
    // Once for the step the page opens on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug]);

  const setUp = () =>
    run(async (say) => {
      if (!status.wallet || !status.agent) throw new PasskeyTreasuryError("Reload the page: this wallet's setup is not ready yet.");
      const prepared = await preparePasskeySetupAction(orgSlug, { dailyUsdc: typed(daily), weeklyUsdc: typed(weekly), capUsdc: capTyped });
      if (!prepared.ok || !prepared.setup) throw new PasskeyTreasuryError(prepared.message);
      const setup = prepared.setup;
      // The browser's own setup, from what it shows: anything else is refused before the passkey is asked (Review Focus 1).
      const expected = passkeySetupCalls({
        usdc: ARC_MAINNET.tokens.USDC,
        treasury: status.wallet,
        agent: status.agent,
        dailyUnits: BigInt(setup.dailyUnits),
        weeklyUnits: BigInt(setup.weeklyUnits),
        capUnits: capTyped === null ? null : unitsOf(capTyped),
        salt: setup.salt,
        deployed: setup.deployed,
        gasWei: AGENT_GAS_WEI,
      });
      checkPasskeySetup(setup, expected);
      say(`Confirm with your passkey: your contract with ${figureText(setup.dailyUnits)} a day and ${figureText(setup.weeklyUnits)} in 7 days.`);
      const treasury = await openTreasury(orgSlug, status.wallet, say);
      const outcome = await treasury.send(expected.calls);
      if (await settleSetup(orgSlug, expected.contract, outcome, say, label)) router.refresh();
    });

  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Set up with one confirmation</h3>
      <p className="text-sm leading-relaxed text-ink-2">Your passkey confirms once, and your wallet:</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
        <li>deploys your contract, which lets this workspace&apos;s agent pay from your wallet, never past its figures;</li>
        <li>approves it to move your USDC{capTyped !== null && capTyped > 0 ? `, up to ${capTyped} USDC` : ""};</li>
        <li>sends 0.50 USDC to the agent&apos;s wallet for its gas.</li>
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="passkey-treasury-daily" label="Daily figure (USDC)" description="Empty uses the agent's spending limit.">
          <Input id="passkey-treasury-daily" inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} />
        </Field>
        <Field id="passkey-treasury-weekly" label="7-day figure (USDC)" description="Empty uses the agent's spending limit.">
          <Input id="passkey-treasury-weekly" inputMode="decimal" value={weekly} onChange={(event) => setWeekly(event.target.value)} />
        </Field>
      </div>
      <Field id="passkey-treasury-cap" label="Cap (USDC)" description="Empty approves without a cap; the figures still bound each day and 7 days." optional>
        <Input id="passkey-treasury-cap" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
      </Field>
      <p className="text-xs text-ink-3">The network fee is paid from your wallet&apos;s USDC: about 0.05 USDC.</p>
      <div>
        <Button type="button" icon={<KeyRound />} loading={busy} onClick={setUp}>
          Set up with your passkey
        </Button>
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </>
  );
}

/** The agent's gas, sent again from the passkey wallet where it ran short (W10). */
function GasStep({ orgSlug, status, label }: { orgSlug: string; status: WalletTreasuryStatus; label: string }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("setup");
  const topUp = () =>
    run(async (say) => {
      if (!status.wallet || !status.agent) throw new PasskeyTreasuryError("Reload the page: this wallet's setup is not ready yet.");
      const prepared = await prepareAgentGasAction(orgSlug);
      if (!prepared.ok || !prepared.transaction) throw new PasskeyTreasuryError(prepared.message);
      const transaction = prepared.transaction;
      // Exactly 0.50 USDC to the agent, or nothing (Review Focus 1).
      if (transaction.to?.toLowerCase() !== status.agent.toLowerCase() || transaction.data !== "0x" || BigInt(transaction.value) !== AGENT_GAS_WEI) {
        throw new PasskeyTreasuryError(SETUP_MISMATCH);
      }
      const treasury = await openTreasury(orgSlug, status.wallet, say);
      const outcome = await treasury.send([{ to: status.agent as Hex, data: "0x", value: AGENT_GAS_WEI }]);
      if (outcome.kind === "reverted") throw new PasskeyTreasuryError(`${label} refused it; nothing moved.`);
      say(`Sent. This updates once ${label} confirms it.`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(POLL_MS);
        router.refresh();
      }
    });
  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Give the agent its gas</h3>
      <p className="text-sm leading-relaxed text-ink-2">
        On {label} the agent pays its own gas in USDC. Send it 0.50 USDC from your wallet; going live needs it to hold at least {status.agentGasMinimumUsdc} USDC.
      </p>
      <div>
        <Button type="button" icon={<Wallet />} loading={busy} onClick={topUp}>
          Send 0.50 USDC for gas
        </Button>
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </>
  );
}

/** A recovery phrase before going live (K8): made here, shown once, registered with the passkey; or skipped, knowingly. */
function RecoveryStep({ orgSlug, status, label }: { orgSlug: string; status: WalletTreasuryStatus; label: string }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("recovery");
  const [words, setWords] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const register = () =>
    run(async (say) => {
      if (!words || !status.wallet) return;
      const recoveryAddress = mnemonicToAccount(words).address;
      const treasury = await openTreasury(orgSlug, status.wallet, say);
      say("Confirm with your passkey to register the phrase.");
      const outcome = await treasury.registerRecovery(recoveryAddress);
      if (outcome.kind === "reverted") throw new PasskeyTreasuryError(`${label} refused the registration; nothing changed.`);
      if (outcome.kind === "unconfirmed") {
        say(`Sent. ${label} has not confirmed it yet; reload this page in a minute, and register it again if it still asks.`);
        return;
      }
      say(`Sent. Waiting for ${label} to confirm it…`);
      for (let attempt = 0; attempt < POLL_TRIES; attempt += 1) {
        const answer = await recordRecoveryAction(orgSlug, { recoveryAddress, txHash: outcome.txHash });
        if (answer.ok && answer.state === "verified") {
          setWords(null);
          router.refresh();
          return;
        }
        if (!answer.ok && !answer.chainUnreadable) throw new PasskeyTreasuryError(answer.message);
        await sleep(POLL_MS);
      }
      say(`${label} has not confirmed it yet. Reload this page to check again.`);
    });

  const skip = () =>
    run(async () => {
      const skipped = await skipRecoveryAction(orgSlug);
      if (!skipped.ok) throw new PasskeyTreasuryError(skipped.message);
      router.refresh();
    });

  let phrase: ReactNode;
  if (words) {
    phrase = (
      <div className="space-y-3">
        <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line bg-surface-2 p-3 font-mono text-sm text-ink sm:grid-cols-3">
          {words.split(" ").map((word, index) => (
            <li key={index} className="flex gap-2">
              <span className="w-5 text-right text-ink-3">{index + 1}.</span>
              <span>{word}</span>
            </li>
          ))}
        </ol>
        <CopyButton value={words} label="Copy the twelve words" />
        <Checkbox id="passkey-treasury-saved" checked={saved} onCheckedChange={(value) => setSaved(value === true)} label="I saved these twelve words somewhere safe, away from this device." />
        <div>
          <Button type="button" icon={<KeyRound />} loading={busy} disabled={!saved} onClick={register}>
            Register with your passkey
          </Button>
        </div>
      </div>
    );
  } else {
    phrase = (
      <div>
        <Button type="button" icon={<ShieldCheck />} onClick={() => setWords(generateMnemonic(english))}>
          Create a recovery phrase
        </Button>
      </div>
    );
  }

  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Save a recovery phrase</h3>
      <p className="text-sm leading-relaxed text-ink-2">
        If this passkey is ever lost, twelve words let you add a new one and keep your wallet. They are made in this browser and never sent to Vestiarion;
        your passkey registers them on {label} as a recovery key for your wallet.
      </p>
      {phrase}
      <div>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="sm">
              Skip: I understand that losing this passkey loses this wallet
            </Button>
          }
          title="Go without a recovery phrase?"
          description="If this passkey is lost, no one can recover this wallet or the USDC in it, Vestiarion included."
          confirmLabel="Skip the recovery phrase"
          onConfirm={skip}
        />
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </>
  );
}

/** The passkey route's steps after the choice, one at a time (K5–K8). */
export default function PasskeyTreasurySteps({ orgSlug, status, network }: { orgSlug: string; status: WalletTreasuryStatus; network: Network }) {
  const label = networkProfile(network).label;
  let body: ReactNode = null;
  if (status.step === "agent") body = <AgentStep orgSlug={orgSlug} />;
  else if (status.step === "deploy" || status.step === "approve") {
    body = (status.walletUsdc ?? 0) < status.setupNeedsUsdc ? <FundStep status={status} label={label} /> : <SetupStep orgSlug={orgSlug} status={status} label={label} />;
  } else if (status.step === "gas") body = <GasStep orgSlug={orgSlug} status={status} label={label} />;
  else if (status.step === "recovery") body = <RecoveryStep orgSlug={orgSlug} status={status} label={label} />;

  return (
    <Card className="space-y-4 p-5">
      <div className="space-y-1">
        <p className="text-xs font-medium text-ink-3">Step 2 of 3</p>
        <h3 className="text-sm font-semibold text-ink">Set up your passkey wallet as the treasury</h3>
      </div>
      <WalletTreasurySummary status={status} network={network} />
      {body && <div className="space-y-3 border-t border-line pt-4">{body}</div>}
    </Card>
  );
}
