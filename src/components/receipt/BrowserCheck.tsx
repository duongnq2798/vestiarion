"use client";

import { useEffect, useState } from "react";
import { verifyEntry, type EntryCheck, type PublicLedgerRow } from "@/lib/receipts/verify";

/**
 * The receipt entry checked again in the reader's browser (docs/superpowers/specs/2026-10-01-payment-receipts-design.md
 * R5): the same verifier the server ran, over Web Crypto, so the page does not only vouch for itself.
 */
export function BrowserCheck({ entry, publicKeys }: { entry: PublicLedgerRow; publicKeys: Record<string, string> }) {
  const [check, setCheck] = useState<EntryCheck | null>(null);

  useEffect(() => {
    let current = true;
    verifyEntry(entry, publicKeys).then(
      (result) => current && setCheck(result),
      () => current && setCheck({ ok: null, reason: "This browser could not run the check." })
    );
    return () => {
      current = false;
    };
  }, [entry, publicKeys]);

  return (
    <p className="text-xs text-ink-3" aria-live="polite">
      {check === null
        ? "Checking again in your browser…"
        : check.ok === true
          ? "Checked again in your browser: the body hash, the signature and the chain hash all verify."
          : `Checked again in your browser: ${check.reason}`}
    </p>
  );
}
