"use client";

import { KeyRound, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { parseEther, type Hex } from "viem";
import {
  choosePasskeyTreasuryAction,
  createAgentWalletAction,
  prepareAgentGasAction,
  preparePasskeySetupAction,
  recordPasskeySetupAction,
  recordRecoveryAction,
  skipRecoveryAction,
} from "@/app/actions/wallet-treasury";
import { PhoneHandoff } from "@/components/treasury/PhoneHandoff";
import { WalletTreasurySummary } from "@/components/treasury/WalletTreasurySteps";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import { ARC_MAINNET, networkProfile, type Network } from "@/lib/network";
import {
  browserKeepingStore,
  checkPasskeySetup,
  forgetCredential,
  keepCredential,
  keptCredential,
  openPasskeyTreasury,
  passkeySetupCalls,
  passkeyStepView,
  passkeyTreasuryConfig,
  passkeyTreasuryFailure,
  PasskeyTreasuryError,
  pendingSetup,
  pollRecord,
  SETUP_MISMATCH,
  settlePasskeySetup,
  type PasskeyTreasury,
} from "@/lib/passkey-treasury";
import { passkeyMark, passkeyName } from "@/lib/passkey-wallet";
import type { SendOutcome } from "@/lib/passkey-wallet-send";
import type { WalletTreasuryStatus } from "@/lib/treasury/wallet-treasury";

/**
 * Go live's passkey route (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md K5–K10): the owner's passkey
 * wallet funded, set up with one confirmation, and its recovery registered or skipped. The server builds what the
 * passkey signs; the browser builds it again from what it shows and refuses anything else, since a passkey prompt shows
 * no transaction.
 */

const POLL_MS = 5_000;
const POLL_TRIES = 24;
const FUND_POLL_MS = 10_000;
const AGENT_GAS_WEI = parseEther("0.5");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Note = { tone: "neutral" | "error"; text: string } | null;
type During = "create" | "open" | "setup" | "recovery" | "check";

const keepingStore = browserKeepingStore;

/** What a person typed as USDC: empty is "not set". */
const typed = (value: string): number | null => (value.trim() === "" ? null : Number(value));
/** USDC in its 6-decimal units, rounded once, as the server rounds them. */
const unitsOf = (usdc: number) => BigInt(Math.round(usdc * 1_000_000));
const startingFigure = (usdc: number | null) => (usdc === null ? "" : String(usdc));

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
        Your face, fingerprint or device PIN signs for the wallet: Face ID, Touch ID, Windows Hello, or your phone. No extension to install, and one
        confirmation sets it up. The treasury stays yours: Vestiarion never holds your USDC.
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
      <PhoneHandoff kind="create" />
    </div>
  );
}

/**
 * The treasury's passkey wallet: with the passkey this browser kept, without a prompt until it signs, or the one the
 * owner picks. A passkey owning another wallet is refused by name (Review Focus 3); a kept one that does is forgotten.
 */
export async function openTreasury(orgSlug: string, expected: string, say: (text: string) => void): Promise<PasskeyTreasury> {
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

/** Ends a setup the passkey sent, recorded once the chain shows it (K7, K10; final review I3). */
function settle(orgSlug: string, contract: Hex, outcome: SendOutcome, say: (text: string) => void, label: string) {
  return settlePasskeySetup({
    store: keepingStore(),
    orgSlug,
    contract,
    outcome,
    record: (txHash) => recordPasskeySetupAction(orgSlug, { txHash, contract }),
    tries: POLL_TRIES,
    waitMs: POLL_MS,
    label,
    say,
  });
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

/**
 * Below what setup needs (K5; final review I2, I5): the wallet's address is in the summary above, and the page reads its
 * USDC again by itself. Only the setup's own amount is asked for until the recovery phrase is saved.
 */
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
        Send USDC on {label} to <strong className="font-medium text-ink">Your wallet</strong>, the first address above, from an exchange or another
        wallet. Not to the agent&apos;s wallet: setup pays the agent&apos;s gas from yours. Setup needs about {status.setupNeedsUsdc.toFixed(2)} USDC:
        0.50 for the agent&apos;s gas, and up to 0.25 set aside for the network fee, of which about 0.07 is spent. Add only this for now: send what the
        workspace will pay once its recovery phrase is saved.
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

/**
 * A setup sent before this page loaded (K10; final review I3): asked about first, whatever the wallet holds now, and
 * never sent again blind. A kept passkey reads a user operation's receipt without a prompt.
 */
function PendingSetupStep({ orgSlug, status, label }: { orgSlug: string; status: WalletTreasuryStatus; label: string }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("check");
  const check = () =>
    run(async (say) => {
      const store = keepingStore();
      const pending = pendingSetup(store, orgSlug);
      if (!pending || !status.wallet) return;
      say("Checking the setup your passkey sent…");
      let outcome: SendOutcome;
      if (pending.txHash) {
        outcome = { kind: "sent", txHash: pending.txHash };
      } else if (pending.userOpHash && keptCredential(store, orgSlug)) {
        outcome = await (await openTreasury(orgSlug, status.wallet, say)).receipt(pending.userOpHash);
      } else {
        say(`The setup was sent from this browser and ${label} has not confirmed it yet. Check again in a minute; it is not sent twice.`);
        return;
      }
      if ((await settle(orgSlug, pending.contract, outcome, say, label)) === "verified") router.refresh();
    });
  useEffect(() => {
    void check();
    // Once for the step the page opens on: \`check\` reads what is kept as it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug]);
  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Your setup was sent</h3>
      <p className="text-sm leading-relaxed text-ink-2">
        Your passkey confirmed the setup in this browser. It is recorded once {label} confirms it, and it is not sent twice.
      </p>
      <div>
        <Button type="button" variant="secondary" size="sm" icon={<RefreshCw />} loading={busy} onClick={() => void check()}>
          Check again
        </Button>
      </div>
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </>
  );
}

/**
 * One confirmation sets everything up (K6): built by the server, built again here from the figures the form shows, then
 * signed. The figures start from the workspace's own spending limit, so the owner sees them before the button (final
 * review I4); the agent's gas is left out where it holds its own (final review I3).
 */
function SetupStep({ orgSlug, status, label }: { orgSlug: string; status: WalletTreasuryStatus; label: string }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("setup");
  const [daily, setDaily] = useState(startingFigure(status.limitDailyUsdc));
  const [weekly, setWeekly] = useState(startingFigure(status.limitWeeklyUsdc));
  const [cap, setCap] = useState("");
  const capTyped = typed(cap);
  const agentFunded = status.agentGasMinimumUsdc <= 0 || (status.agentGasUsdc !== null && status.agentGasUsdc >= status.agentGasMinimumUsdc);

  const setUp = () =>
    run(async (say) => {
      if (!status.wallet || !status.agent) throw new PasskeyTreasuryError("Reload the page: this wallet's setup is not ready yet.");
      const dailyTyped = typed(daily);
      const weeklyTyped = typed(weekly);
      const prepared = await preparePasskeySetupAction(orgSlug, { dailyUsdc: dailyTyped, weeklyUsdc: weeklyTyped, capUsdc: capTyped });
      if (!prepared.ok || !prepared.setup) throw new PasskeyTreasuryError(prepared.message);
      const setup = prepared.setup;
      if (setup.chainId !== ARC_MAINNET.chainId) throw new PasskeyTreasuryError(SETUP_MISMATCH);
      // The browser's own setup, from what the form shows: anything else is refused before the passkey is asked
      // (Review Focus 1). An empty figure is the workspace's own, as the server reads it.
      const figureUnits = (value: number | null, limit: number | null) => (value !== null ? unitsOf(value) : limit !== null ? unitsOf(limit) : 0n);
      const expected = passkeySetupCalls({
        usdc: ARC_MAINNET.tokens.USDC,
        treasury: status.wallet,
        agent: status.agent,
        dailyUnits: figureUnits(dailyTyped, status.limitDailyUsdc),
        weeklyUnits: figureUnits(weeklyTyped, status.limitWeeklyUsdc),
        capUnits: capTyped === null ? null : unitsOf(capTyped),
        salt: setup.salt,
        deployed: setup.deployed,
        agentFunded,
        gasWei: AGENT_GAS_WEI,
      });
      checkPasskeySetup(setup, expected);
      say("Confirm the setup with your passkey.");
      const treasury = await openTreasury(orgSlug, status.wallet, say);
      const outcome = await treasury.send(expected.calls);
      if ((await settle(orgSlug, expected.contract, outcome, say, label)) === "verified") router.refresh();
    });

  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Set up with one confirmation</h3>
      <p className="text-sm leading-relaxed text-ink-2">Your passkey confirms once, and your wallet:</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
        <li>deploys your contract, which lets this workspace&apos;s agent pay from your wallet, never past the figures below;</li>
        <li>approves it to move your USDC{capTyped !== null && capTyped > 0 ? `, up to ${capTyped} USDC` : ""};</li>
        <li>{agentFunded ? "leaves the agent's gas as it is: it holds its own already." : "sends 0.50 USDC to the agent's wallet for its gas."}</li>
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="passkey-treasury-daily" label="Daily figure (USDC)" description="From the agent's spending limit; change it here if you like.">
          <Input id="passkey-treasury-daily" inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} />
        </Field>
        <Field id="passkey-treasury-weekly" label="7-day figure (USDC)" description="From the agent's spending limit; change it here if you like.">
          <Input id="passkey-treasury-weekly" inputMode="decimal" value={weekly} onChange={(event) => setWeekly(event.target.value)} />
        </Field>
      </div>
      <Field id="passkey-treasury-cap" label="Cap (USDC)" description="Empty approves without a cap; the figures still bound each day and 7 days." optional>
        <Input id="passkey-treasury-cap" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
      </Field>
      <p className="text-xs text-ink-3">The network fee is paid from your wallet&apos;s USDC: about 0.07 USDC.</p>
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
      if (outcome.kind === "reverted") throw new PasskeyTreasuryError(`${label} did not carry it out; only its network fee was spent.`);
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

/**
 * A recovery phrase before going live (K8; final review I5): twelve words made here, shown once, never sent, and said
 * plainly to be a full owner of the wallet; registered with the passkey, or skipped knowingly.
 */
function RecoveryStep({ orgSlug, status, label }: { orgSlug: string; status: WalletTreasuryStatus; label: string }) {
  const router = useRouter();
  const { busy, note, run } = usePasskeyStep("recovery");
  const [words, setWords] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const create = () =>
    run(async () => {
      // Loaded here, when asked for: the word list and key derivation weigh on every other visit to Settings.
      const { english, generateMnemonic } = await import("viem/accounts");
      setWords(generateMnemonic(english));
    });

  const register = () =>
    run(async (say) => {
      if (!words || !status.wallet) return;
      const { mnemonicToAccount } = await import("viem/accounts");
      const recoveryAddress = mnemonicToAccount(words).address;
      const treasury = await openTreasury(orgSlug, status.wallet, say);
      say("Confirm with your passkey to register the phrase.");
      const outcome = await treasury.registerRecovery(recoveryAddress);
      if (outcome.kind === "reverted") throw new PasskeyTreasuryError(`${label} did not carry out the registration; only its network fee was spent.`);
      if (outcome.kind === "unconfirmed") {
        say(`Sent. ${label} has not confirmed it yet; reload this page in a minute, and register it again if it still asks.`);
        return;
      }
      say(`Sent. Waiting for ${label} to confirm it…`);
      const polled = await pollRecord({
        record: () => recordRecoveryAction(orgSlug, { recoveryAddress, txHash: outcome.txHash }),
        tries: POLL_TRIES,
        waitMs: POLL_MS,
      });
      if (polled.state === "verified") {
        setWords(null);
        router.refresh();
        return;
      }
      if (polled.state === "refused") throw new PasskeyTreasuryError(polled.message);
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
        <Checkbox id="passkey-treasury-saved" checked={saved} onCheckedChange={(value) => setSaved(value === true)} label="I wrote these twelve words down and keep them offline." />
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
        <Button type="button" icon={<ShieldCheck />} loading={busy} onClick={create}>
          Create a recovery phrase
        </Button>
      </div>
    );
  }

  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Save a recovery phrase</h3>
      <p className="text-sm leading-relaxed text-ink-2">
        Twelve words that can sign for this wallet on their own: anyone who has them can move every USDC in it. Write them on paper and keep them
        offline; Vestiarion will never ask for them. If this passkey is ever lost, they let you add a new one and keep the wallet. They are made in this
        browser and never sent anywhere; your passkey registers them on {label}.
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

/** The passkey route's steps after the choice, one at a time (K5–K8); a setup sent before is checked first. */
export default function PasskeyTreasurySteps({ orgSlug, status, network }: { orgSlug: string; status: WalletTreasuryStatus; network: Network }) {
  const label = networkProfile(network).label;
  // Read in the browser only: the server renders as if nothing is kept, and the browser then shows a setup it sent.
  const pending = useSyncExternalStore(neverChanges, () => pendingSetup(keepingStore(), orgSlug) !== null, () => false);
  const view = passkeyStepView({ step: status.step, walletUsdc: status.walletUsdc, setupNeedsUsdc: status.setupNeedsUsdc, pending });
  let body: ReactNode = null;
  if (view === "agent") body = <AgentStep orgSlug={orgSlug} />;
  else if (view === "pending") body = <PendingSetupStep orgSlug={orgSlug} status={status} label={label} />;
  else if (view === "fund") body = <FundStep status={status} label={label} />;
  else if (view === "setup") body = <SetupStep orgSlug={orgSlug} status={status} label={label} />;
  else if (view === "gas") body = <GasStep orgSlug={orgSlug} status={status} label={label} />;
  else if (view === "recovery") body = <RecoveryStep orgSlug={orgSlug} status={status} label={label} />;

  return (
    <Card className="space-y-4 p-5">
      <div className="space-y-1">
        <p className="text-xs font-medium text-ink-3">Step 2 of 3</p>
        <h3 className="text-sm font-semibold text-ink">Set up your passkey wallet as the treasury</h3>
      </div>
      <WalletTreasurySummary status={status} network={network} />
      {body && (
        <div className="space-y-3 border-t border-line pt-4">
          {body}
          {/* Where the passkey signs, it can sign on a phone instead (src/lib/passkey-handoff.ts). */}
          {(view === "setup" || view === "gas" || view === "recovery") && <PhoneHandoff kind="confirm" />}
        </div>
      )}
    </Card>
  );
}
