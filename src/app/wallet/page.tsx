import type { Metadata } from "next";
import { PasskeyWallet } from "@/components/wallet/PasskeyWallet";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { passkeyWalletConfig } from "@/lib/passkey-wallet";

export const metadata: Metadata = {
  title: "Your wallet",
  robots: { index: false, follow: false },
};

/**
 * Where a payee opens the passkey wallet they created from a payee link (docs/superpowers/specs/2026-10-05-payee-passkey-
 * wallet-design.md P4). No session: the passkey is the credential, and the page keeps nothing.
 */
export default function WalletPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          <PasskeyWallet configured={passkeyWalletConfig() !== null} />
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
