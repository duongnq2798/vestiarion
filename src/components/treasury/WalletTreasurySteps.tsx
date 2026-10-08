"use client";

import { ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  createAgentWalletAction,
  prepareAgentGasAction,
  prepareApprovalAction,
  prepareDeploymentAction,
  recordApprovalAction,
  recordDeploymentAction,
  type PreparedActionResult,
  type RecordActionResult,
} from "@/app/actions/wallet-treasury";
import AddUsdcFromChain from "@/components/treasury/AddUsdcFromChain";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { connectWallet, discoverWallets, ensureNetwork, sendPrepared, walletErrorMessage, type DiscoveredWallet, type WalletWindow } from "@/lib/browser-wallet";
import { networkProfile, type Network } from "@/lib/network";
import { forgetSent, recordSent, rememberSent, sentHash, type SentStep, type SentStore } from "@/lib/treasury/sent-transaction";
import type { WalletTreasuryStatus } from "@/lib/treasury/wallet-treasury";

/**
 * Go live with the owner's own wallet as the treasury (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md W3,
 * W5–W10). The owner's browser wallet signs and sends what the server builds; the server reads each result back from
 * the chain. The page holds no secret and no Circle wallet id.
 */

const POLL_MS = 5_000;
const POLL_TRIES = 24;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Note = { tone: "neutral" | "error"; text: string } | null;

/** Where a sent transaction is kept until it is recorded; none where the browser refuses storage. */
function sentStore(): SentStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const notConfirmed = (networkLabel: string) =>
  `${networkLabel} has not confirmed it yet. Reload this page to check again; if your wallet shows it failed, send it again.`;

/** The figures a person typed: empty is "not set", anything else a number of USDC, or NaN the server refuses. */
const figure = (value: string): number | null => (value.trim() === "" ? null : Number(value));

/** An address, with a button that copies it. */
export function WalletAddress({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 break-all font-mono text-xs text-ink-2">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** The wallet in this browser, the one the person picked when there are several, on the workspace's network. */
export function useOwnerWallet(network: Network) {
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [picked, setPicked] = useState(0);
  useEffect(() => {
    let alive = true;
    void discoverWallets(window as unknown as WalletWindow).then((found) => alive && setWallets(found));
    return () => {
      alive = false;
    };
  }, []);
  const open = async (expected: string | null) => {
    const wallet = wallets?.[picked];
    if (!wallet) throw new Error("No wallet was found in this browser. Install a wallet such as MetaMask or Rabby, then reload the page.");
    const address = await connectWallet(wallet.provider);
    if (expected && address.toLowerCase() !== expected.toLowerCase()) throw new Error(`Switch your wallet to ${expected} first: it is this workspace's treasury.`);
    await ensureNetwork(wallet.provider, networkProfile(network));
    return { provider: wallet.provider, address };
  };
  return { wallets, picked, setPicked, open };
}

export function WalletPicker({ wallets, picked, onPick }: { wallets: DiscoveredWallet[] | null; picked: number; onPick: (index: number) => void }) {
  if (!wallets || wallets.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Choose a wallet">
      {wallets.map((wallet, index) => (
        <Button key={wallet.id} type="button" size="sm" variant={index === picked ? "primary" : "secondary"} onClick={() => onPick(index)} aria-pressed={index === picked}>
          {wallet.name}
        </Button>
      ))}
    </div>
  );
}

/** Runs a step, keeping its outcome in words; a wallet's refusal is said plainly. */
export function useStep() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
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
  return { busy, note, run };
}

const usdc = (value: number | null) => (value === null ? "not read" : `${value} USDC`);

/** What the setup holds, as the chain shows it. */
export function WalletTreasurySummary({ status, network }: { status: WalletTreasuryStatus; network: Network }) {
  const profile = networkProfile(network);
  const rows: Array<[string, ReactNode]> = [];
  if (status.wallet) rows.push(["Your wallet", <WalletAddress key="wallet" value={status.wallet} label="Copy your wallet's address" />]);
  if (status.wallet) rows.push(["USDC in it", usdc(status.walletUsdc)]);
  if (status.agent) rows.push(["The agent's wallet", <WalletAddress key="agent" value={status.agent} label="Copy the agent's address" />]);
  if (status.agent && profile.gasReserveUsdc > 0) rows.push(["The agent's gas", usdc(status.agentGasUsdc)]);
  if (status.contract) rows.push(["Your contract", <WalletAddress key="contract" value={status.contract} label="Copy the contract's address" />]);
  if (status.contract) rows.push(["Its figures", `${status.dailyUsdc === null ? "no daily figure" : `${status.dailyUsdc} USDC a day`}, ${status.weeklyUsdc === null ? "no 7-day figure" : `${status.weeklyUsdc} USDC in 7 days`}`]);
  if (status.contract && status.step !== "approve") rows.push(["The agent can move", usdc(status.spendableUsdc)]);
  if (rows.length === 0) return null;
  return (
    <dl className="grid items-baseline gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="min-w-0 text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Sends what the server built from the owner's wallet, then records it once the chain shows it. The hash is kept in the
 * browser until then, so a reload asks about the same transaction rather than send another.
 */
async function sendAndRecord(
  sent: { orgSlug: string; step: SentStep },
  open: () => Promise<{ provider: DiscoveredWallet["provider"]; address: string }>,
  prepare: () => Promise<PreparedActionResult>,
  record: (hash: string) => Promise<RecordActionResult>,
  say: (text: string) => void,
  networkLabel: string
): Promise<"verified" | "pending"> {
  const { provider, address } = await open();
  const prepared = await prepare();
  if (!prepared.ok || !prepared.transaction) throw new Error(prepared.message);
  say("Confirm it in your wallet.");
  const hash = await sendPrepared(provider, address, prepared.transaction);
  const store = sentStore();
  rememberSent(store, sent.orgSlug, sent.step, hash);
  say(`Sent. Waiting for ${networkLabel} to confirm it…`);
  const outcome = await recordSent({ store, ...sent, hash, record, tries: POLL_TRIES, waitMs: POLL_MS });
  if (outcome === "pending") say(notConfirmed(networkLabel));
  return outcome;
}

const recordStep = (orgSlug: string, step: SentStep) => (hash: string) => (step === "deploy" ? recordDeploymentAction(orgSlug, hash) : recordApprovalAction(orgSlug, hash));

/** The steps after the wallet is proven (W5–W10), one at a time. */
export default function WalletTreasurySteps({ orgSlug, status, network }: { orgSlug: string; status: WalletTreasuryStatus; network: Network }) {
  const router = useRouter();
  const profile = networkProfile(network);
  const wallet = useOwnerWallet(network);
  const { busy, note, run } = useStep();
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [cap, setCap] = useState("");
  const open = () => wallet.open(status.wallet);

  // A transaction sent for this step before the page was reloaded or closed is asked about again, not sent twice.
  useEffect(() => {
    const store = sentStore();
    for (const kept of ["deploy", "approve"] as const) if (kept !== status.step) forgetSent(store, orgSlug, kept);
    if (status.step !== "deploy" && status.step !== "approve") return;
    const step: SentStep = status.step;
    const hash = sentHash(store, orgSlug, step);
    if (!hash) return;
    void run(async (say) => {
      say("Checking the transaction your wallet sent…");
      const outcome = await recordSent({ store, orgSlug, step, hash, record: recordStep(orgSlug, step), tries: 1, waitMs: POLL_MS });
      if (outcome === "verified") router.refresh();
      else say(notConfirmed(profile.label));
    });
    // Once for each step the page opens on: `run`, `router` and the label do not change what is asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, status.step]);

  let body: ReactNode = null;
  if (status.step === "agent") {
    body = (
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
                if (!created.ok) throw new Error(created.message);
                router.refresh();
              })
            }
          >
            Create the agent&apos;s wallet
          </Button>
        </div>
      </>
    );
  } else if (status.step === "deploy") {
    body = (
      <>
        <h3 className="text-sm font-semibold text-ink">Deploy your contract</h3>
        <p className="text-sm leading-relaxed text-ink-2">
          Your wallet deploys the contract that lets this workspace&apos;s agent pay from it, never past these figures. Only your wallet can change them
          later. It costs a little USDC of gas on {profile.label}.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="wallet-treasury-daily" label="Daily figure (USDC)" description="Empty uses the agent's spending limit.">
            <Input id="wallet-treasury-daily" inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} />
          </Field>
          <Field id="wallet-treasury-weekly" label="7-day figure (USDC)" description="Empty uses the agent's spending limit.">
            <Input id="wallet-treasury-weekly" inputMode="decimal" value={weekly} onChange={(event) => setWeekly(event.target.value)} />
          </Field>
        </div>
        <div>
          <Button
            type="button"
            icon={<Wallet />}
            loading={busy}
            disabled={wallet.wallets === null}
            onClick={() =>
              run(async (say) => {
                const outcome = await sendAndRecord(
                  { orgSlug, step: "deploy" },
                  open,
                  () => prepareDeploymentAction(orgSlug, { dailyUsdc: figure(daily), weeklyUsdc: figure(weekly) }),
                  recordStep(orgSlug, "deploy"),
                  say,
                  profile.label
                );
                if (outcome === "verified") router.refresh();
              })
            }
          >
            Deploy from your wallet
          </Button>
        </div>
      </>
    );
  } else if (status.step === "approve") {
    body = (
      <>
        <h3 className="text-sm font-semibold text-ink">Approve your contract</h3>
        <p className="text-sm leading-relaxed text-ink-2">
          Your wallet lets the contract move its USDC. The contract still pays nothing past its figures, and you can take the approval back from your
          wallet at any time.
        </p>
        <Field id="wallet-treasury-cap" label="Cap (USDC)" description="Empty approves without a cap; the figures still bound each day and 7 days." optional>
          <Input id="wallet-treasury-cap" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
        </Field>
        <div>
          <Button
            type="button"
            icon={<ShieldCheck />}
            loading={busy}
            disabled={wallet.wallets === null}
            onClick={() =>
              run(async (say) => {
                const outcome = await sendAndRecord(
                  { orgSlug, step: "approve" },
                  open,
                  () => prepareApprovalAction(orgSlug, { capUsdc: figure(cap) }),
                  recordStep(orgSlug, "approve"),
                  say,
                  profile.label
                );
                if (outcome === "verified") router.refresh();
              })
            }
          >
            Approve from your wallet
          </Button>
        </div>
      </>
    );
  } else if (status.step === "gas") {
    body = (
      <>
        <h3 className="text-sm font-semibold text-ink">Give the agent its gas</h3>
        <p className="text-sm leading-relaxed text-ink-2">
          On {profile.label} the agent pays its own gas in USDC. Send it 0.50 USDC from your wallet; each payment costs it well under 0.01 USDC. Going
          live needs it to hold at least {status.agentGasMinimumUsdc} USDC.
        </p>
        <div>
          <Button
            type="button"
            icon={<Wallet />}
            loading={busy}
            disabled={wallet.wallets === null}
            onClick={() =>
              run(async (say) => {
                const { provider, address } = await open();
                const prepared = await prepareAgentGasAction(orgSlug);
                if (!prepared.ok || !prepared.transaction) throw new Error(prepared.message);
                say("Confirm it in your wallet.");
                await sendPrepared(provider, address, prepared.transaction);
                say(`Sent. This updates once ${profile.label} confirms it.`);
                for (let attempt = 0; attempt < 3; attempt += 1) {
                  await sleep(POLL_MS);
                  router.refresh();
                }
              })
            }
          >
            Send 0.50 USDC for gas
          </Button>
        </div>
      </>
    );
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="space-y-1">
        <p className="text-xs font-medium text-ink-3">Step 2 of 3</p>
        <h3 className="text-sm font-semibold text-ink">{status.step === "ready" ? "Your wallet is set up" : "Set up your wallet as the treasury"}</h3>
      </div>
      <WalletTreasurySummary status={status} network={network} />
      {body && <div className="space-y-3 border-t border-line pt-4">{body}</div>}
      {status.step !== "wallet" && status.step !== "agent" && status.step !== "ready" && (
        <WalletPicker wallets={wallet.wallets} picked={wallet.picked} onPick={wallet.setPicked} />
      )}
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
      {/* Each step's gas is USDC on the network: CCTP brings it from where the wallet holds it (add USDC B6). */}
      {status.wallet && status.step !== "ready" && <AddUsdcFromChain network={network} recipient={status.wallet} recipientLabel="Your wallet" />}
    </Card>
  );
}
