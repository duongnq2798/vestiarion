"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { passkeyFailure, passkeyMark, passkeyName, passkeyWalletAddress, passkeyWalletConfig } from "@/lib/passkey-wallet";

/** The secondary way to give a payee link an address (payee passkey wallet P1): under the address and its Continue. */
export const PASSKEY_OPTION = "No wallet yet? Create one with a passkey";

/** For a payee who made a passkey wallet from an earlier link: the same wallet, not another (review finding 7). */
export const PASSKEY_REUSE = "Already made one here? Use my passkey wallet";

/** What the option says the wallet is, beneath it. */
export const PASSKEY_OPTION_NOTE =
  "A wallet on Arc testnet that opens with your fingerprint, face or device PIN. No app to install, no recovery phrase, and no fees to receive or send.";

/** Starts loading the SDK early, when the pointer or focus reaches the option, so the passkey prompt follows the tap closely. */
function preload() {
  void import("@/lib/passkey-wallet-sdk").catch(() => undefined);
}

/**
 * Makes a passkey wallet, or uses one made from an earlier link, and hands its address back (P2): the SDK loads only
 * when chosen, so the address path stays light. The browser asks for the passkey; nothing is deployed, paid or kept by
 * Vestiarion. `onPending` lets the form hold its own path while the passkey is asked.
 */
export function PasskeyWalletOption({
  orgName,
  onAddress,
  onPending,
}: {
  orgName: string;
  onAddress: (address: string, mode: "Register" | "Login") => void;
  onPending?: (pending: boolean) => void;
}) {
  const [pending, setPending] = useState<"Register" | "Login" | null>(null);
  const [error, setError] = useState("");

  async function run(mode: "Register" | "Login") {
    const config = passkeyWalletConfig();
    if (!config || pending) return;
    setPending(mode);
    onPending?.(true);
    setError("");
    try {
      const { passkeySdk } = await import("@/lib/passkey-wallet-sdk");
      const { address } = await passkeyWalletAddress({
        config,
        mode,
        ...(mode === "Register" ? { username: passkeyName(orgName, passkeyMark()) } : {}),
        sdk: passkeySdk(),
      });
      onAddress(address, mode);
    } catch (failure) {
      setError(passkeyFailure(failure, mode === "Register" ? "create" : "open"));
    } finally {
      setPending(null);
      onPending?.(false);
    }
  }

  return (
    <div className="grid gap-1.5 border-t border-line pt-4" onPointerEnter={preload} onFocusCapture={preload} onTouchStart={preload}>
      <Button type="button" variant="secondary" icon={<KeyRound />} onClick={() => run("Register")} loading={pending === "Register"} disabled={pending !== null}>
        {pending === "Register" ? "Waiting for your passkey…" : PASSKEY_OPTION}
      </Button>
      <p className="text-center text-xs leading-5 text-ink-3">{PASSKEY_OPTION_NOTE}</p>
      <Button type="button" variant="link" className="justify-self-center" onClick={() => run("Login")} disabled={pending !== null}>
        {pending === "Login" ? "Waiting for your passkey…" : PASSKEY_REUSE}
      </Button>
      <FormMessage tone="error">{error || null}</FormMessage>
    </div>
  );
}
