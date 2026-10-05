"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { createPasskeyWallet, passkeyFailure, passkeyMark, passkeyName, passkeyWalletConfig } from "@/lib/passkey-wallet";

/** The secondary way to give a payee link an address (payee passkey wallet P1): under the address and its Continue. */
export const PASSKEY_OPTION = "No wallet yet? Create one with a passkey";

/** What the option says the wallet is, beneath it. */
export const PASSKEY_OPTION_NOTE =
  "A wallet on Arc testnet that opens with your fingerprint, face or device PIN. No app to install, no recovery phrase, and no fees to receive or send.";

/**
 * Creates a passkey wallet and hands its address back (P2): the SDK loads only now, when chosen, so the address path
 * stays as light as before. The browser asks for the passkey; nothing is deployed, paid or kept by Vestiarion.
 */
export function PasskeyWalletOption({ payeeName, onCreated }: { payeeName: string; onCreated: (address: string) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    const config = passkeyWalletConfig();
    if (!config) return;
    setPending(true);
    setError("");
    try {
      const { passkeySdk } = await import("@/lib/passkey-wallet-sdk");
      const { address } = await createPasskeyWallet({ config, username: passkeyName(payeeName, passkeyMark()), sdk: passkeySdk() });
      onCreated(address);
    } catch (failure) {
      setError(passkeyFailure(failure, "create"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-1.5 border-t border-line pt-4">
      <Button type="button" variant="secondary" icon={<KeyRound />} onClick={create} loading={pending}>
        {pending ? "Waiting for your passkey…" : PASSKEY_OPTION}
      </Button>
      <p className="text-center text-xs leading-5 text-ink-3">{PASSKEY_OPTION_NOTE}</p>
      <FormMessage tone="error">{error || null}</FormMessage>
    </div>
  );
}
