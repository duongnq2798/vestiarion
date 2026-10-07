"use client";

import { Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { chooseWalletTreasuryAction, proofMessageAction } from "@/app/actions/wallet-treasury";
import { PasskeyWalletCard, usePasskeysAvailable } from "@/components/treasury/PasskeyTreasurySteps";
import { useOwnerWallet, useStep, WalletPicker } from "@/components/treasury/WalletTreasurySteps";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { FormMessage } from "@/components/ui/FormMessage";
import { signProof } from "@/lib/browser-wallet";
import type { Network } from "@/lib/network";
import { choiceLead } from "@/lib/passkey-treasury";

/**
 * Go live's choice of where the treasury lives (wallet treasury W1; passkey treasury K1): a wallet in the browser, proven
 * by its signature, or a passkey wallet created here. It leads with what the browser has: the wallet where one is
 * found, a passkey where none is. A missing wallet is never an error before the owner asks for one.
 */
export function WalletTreasuryChoice({ orgSlug, network }: { orgSlug: string; network: Network }) {
  const router = useRouter();
  const wallet = useOwnerWallet(network);
  const { busy, note, run } = useStep();
  const passkeys = usePasskeysAvailable();
  const found = wallet.wallets === null ? null : wallet.wallets.length;
  const lead = choiceLead({ wallets: found, passkeys });
  const name = found === 1 ? wallet.wallets?.[0]?.name : undefined;

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

  const walletCard = (
    <div className={cn("space-y-3 rounded-xl border p-4", lead === "passkey" ? "border-line" : "border-agent-line bg-agent-soft/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">Your own wallet</h4>
        {lead !== "passkey" && (
          <Badge tone="agent" size="sm">
            Recommended
          </Badge>
        )}
      </div>
      <p className="text-sm leading-relaxed text-ink-2">
        The treasury stays in a wallet you hold, such as MetaMask or Rabby. You sign once to prove it is yours, deploy a contract that lets this
        workspace&apos;s agent pay from it within the daily and 7-day figures you set, and approve it. Vestiarion never holds your USDC, and you can stop
        it from your wallet at any time. No Circle account is needed.
      </p>
      {found === 0 ? (
        <p className="text-sm leading-relaxed text-ink-2">
          {passkeys ? "No browser wallet was found here, so the passkey comes first. " : ""}To use MetaMask or Rabby, install one, then reload this page.
        </p>
      ) : (
        <>
          <WalletPicker wallets={wallet.wallets} picked={wallet.picked} onPick={wallet.setPicked} />
          <div>
            <Button type="button" icon={<Wallet />} loading={busy} onClick={prove} disabled={found === null}>
              {name ? `Connect ${name}` : "Connect your wallet"}
            </Button>
          </div>
        </>
      )}
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </div>
  );
  const passkeyCard = passkeys ? <PasskeyWalletCard orgSlug={orgSlug} lead={lead === "passkey"} /> : null;

  return (
    <div className="space-y-3">
      {lead === "passkey" ? passkeyCard : walletCard}
      {lead === "passkey" ? walletCard : passkeyCard}
    </div>
  );
}
