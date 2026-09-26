"use client";

import { useState, useTransition } from "react";

interface VerificationResponse {
  /** `null` is "not checked" — see `VerificationResult` in `lib/ledger`. */
  valid?: boolean | null;
  checkedEntries?: number;
  brokenAt?: number;
  reason?: string;
  /** Configuration problems met on the way to the verdict; not about the chain. */
  warnings?: string[];
}

export default function VerifyLedgerBadge() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<VerificationResponse | null>(null);

  function verify() {
    startTransition(async () => {
      try {
        const response = await fetch("/api/ledger/verify");
        setResult((await response.json()) as VerificationResponse);
      } catch (error) {
        // A request that never arrived checked nothing. Calling that `false`
        // would accuse the chain of being broken because the network was.
        setResult({ valid: null, reason: error instanceof Error ? error.message : "Verification request failed" });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <button
        type="button"
        disabled={pending}
        onClick={verify}
        className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-ink-3 px-3.5 text-[0.8125rem] font-medium text-ink hover:bg-raised disabled:opacity-70"
      >
        <span aria-hidden className={pending ? "motion-safe:animate-spin" : ""}>✦</span>
        {pending ? "Checking every signature…" : result ? "Verify again" : "Verify hash chain"}
      </button>
      <p aria-live="polite" className="min-h-5 text-[0.8125rem]">
        {result?.valid === true && <span className="text-proof">Chain intact — {result.checkedEntries ?? 0} signatures and {Math.max((result.checkedEntries ?? 0) - 1, 0)} links verified.</span>}
        {result?.valid === false && <span className="text-refused">Chain broken{result.brokenAt ? ` at #${String(result.brokenAt).padStart(4, "0")}` : ""}: {result.reason ?? "verification failed"}</span>}
        {result != null && result.valid == null && <span className="text-ink-3">Not checked — {result.reason ?? "no verdict was produced"}. This is not a finding about the chain.</span>}
        {!result && !pending && <span className="text-ink-3">Not yet verified in this session.</span>}
        {result?.warnings?.map((warning) => (
          <span key={warning} className="block text-refused">Configuration: {warning}</span>
        ))}
      </p>
    </div>
  );
}
