"use client";

import { ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  chooseWalletTreasuryAction,
  createAgentWalletAction,
  prepareAgentGasAction,
  prepareApprovalAction,
  prepareDeploymentAction,
  proofMessageAction,
  recordApprovalAction,
  recordDeploymentAction,
  type PreparedActionResult,
  type RecordActionResult,
} from "@/app/actions/wallet-treasury";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { connectWallet, discoverWallets, ensureNetwork, sendPrepared, signProof, walletErrorMessage, type DiscoveredWallet, type WalletWindow } from "@/lib/browser-wallet";
import { networkProfile, type Network } from "@/lib/network";
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

/** The figures a person typed: empty is "not set", anything else a number of USDC, or NaN the server refuses. */
const figure = (value: string): number | null => (value.trim() === "" ? null : Number(value));

function Address({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 break-all font-mono text-xs text-ink-2">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** The wallet in this browser, the one the person picked when there are several, on the workspace's network. */
function useOwnerWallet(network: Network) {
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

function WalletPicker({ wallets, picked, onPick }: { wallets: DiscoveredWallet[] | null; picked: number; onPick: (index: number) => void }) {
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
function useStep() {
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

/** The connect step's choice (W1): the owner's own wallet, offered where the deployment has an agent account. */
export function WalletTreasuryChoice({ orgSlug, network }: { orgSlug: string; network: Network }) {
  const router = useRouter();
  const wallet = useOwnerWallet(network);
  const { busy, note, run } = useStep();
  const prove = () =>
    run(async (say) => {
      const { provider, address } = await wallet.open(null);
      const asked = await proofMessageAction(orgSlug, address);
      if (!asked.ok || !asked.text) throw new Error(asked.message);
      say("Sign the message in your wallet. It only proves the wallet is yours; nothing is sent.");
      const signature = await signProof(provider, address, asked.text);
      const chosen = await chooseWalletTreasuryAction(orgSlug, { address, message: asked.text, signature });
      if (!chosen.ok) throw new Error(chosen.message);
      say(chosen.message);
      router.refresh();
    });
  return (
    <div className="space-y-3 rounded-xl border border-agent-line bg-agent-soft/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">Your own wallet</h4>
        <Badge tone="agent" size="sm">
          Recommended
        </Badge>
      </div>
      <p className="text-sm leading-relaxed text-ink-2">
        The treasury stays in a wallet you hold, such as MetaMask or Rabby. You sign once to prove it is yours, deploy a contract that lets this
        workspace&apos;s agent pay from it within the daily and 7-day figures you set, and approve it. Vestiarion never holds your USDC, and you can stop
        it from your wallet at any time. No Circle account is needed.
      </p>
      <WalletPicker wallets={wallet.wallets} picked={wallet.picked} onPick={wallet.setPicked} />
      <div>
        <Button type="button" icon={<Wallet />} loading={busy} onClick={prove} disabled={wallet.wallets === null}>
          Connect your wallet
        </Button>
      </div>
      {wallet.wallets?.length === 0 && <p className="text-xs text-ink-3">No wallet was found in this browser. Install one, such as MetaMask or Rabby, then reload.</p>}
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </div>
  );
}

const usdc = (value: number | null) => (value === null ? "not read" : `${value} USDC`);

/** What the setup holds, as the chain shows it. */
export function WalletTreasurySummary({ status, network }: { status: WalletTreasuryStatus; network: Network }) {
  const profile = networkProfile(network);
  const rows: Array<[string, ReactNode]> = [];
  if (status.wallet) rows.push(["Your wallet", <Address key="wallet" value={status.wallet} label="Copy your wallet's address" />]);
  if (status.wallet) rows.push(["USDC in it", usdc(status.walletUsdc)]);
  if (status.agent) rows.push(["The agent's wallet", <Address key="agent" value={status.agent} label="Copy the agent's address" />]);
  if (status.agent && profile.gasReserveUsdc > 0) rows.push(["The agent's gas", usdc(status.agentGasUsdc)]);
  if (status.contract) rows.push(["Your contract", <Address key="contract" value={status.contract} label="Copy the contract's address" />]);
  if (status.contract) rows.push(["Its figures", `${status.dailyUsdc === null ? "no daily figure" : `${status.dailyUsdc} USDC a day`}, ${status.weeklyUsdc === null ? "no 7-day figure" : `${status.weeklyUsdc} USDC in 7 days`}`]);
  if (status.contract && status.step !== "approve") rows.push(["The agent can move", usdc(status.spendableUsdc)]);
  if (rows.length === 0) return null;
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="min-w-0 text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Sends what the server built from the owner's wallet, then records it once the chain shows it. */
async function sendAndRecord(
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
  say(`Sent. Waiting for ${networkLabel} to confirm it…`);
  for (let attempt = 0; attempt < POLL_TRIES; attempt += 1) {
    const recorded = await record(hash);
    if (!recorded.ok) throw new Error(recorded.message);
    if (recorded.state === "verified") return "verified";
    await sleep(POLL_MS);
  }
  say(`${networkLabel} has not confirmed it yet. Reload the page in a minute; it is recorded once it confirms.`);
  return "pending";
}

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
                  open,
                  () => prepareDeploymentAction(orgSlug, { dailyUsdc: figure(daily), weeklyUsdc: figure(weekly) }),
                  (hash) => recordDeploymentAction(orgSlug, hash),
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
                  open,
                  () => prepareApprovalAction(orgSlug, { capUsdc: figure(cap) }),
                  (hash) => recordApprovalAction(orgSlug, hash),
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
        <p className="text-xs font-medium text-ink-3">Your own wallet</p>
        <h3 className="text-sm font-semibold text-ink">{status.step === "ready" ? "Your wallet is set up" : "Set up your wallet as the treasury"}</h3>
      </div>
      <WalletTreasurySummary status={status} network={network} />
      {body && <div className="space-y-3 border-t border-line pt-4">{body}</div>}
      {status.step !== "agent" && status.step !== "ready" && <WalletPicker wallets={wallet.wallets} picked={wallet.picked} onPick={wallet.setPicked} />}
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </Card>
  );
}
