"use client";

import { useState, useTransition } from "react";

interface VerificationResponse {
  valid?: boolean;
  checkedEntries?: number;
  brokenAt?: number;
  reason?: string;
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
        setResult({ valid: false, reason: error instanceof Error ? error.message : "Verification request failed" });
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
        {!result && !pending && <span className="text-ink-3">Not yet verified in this session.</span>}
      </p>
    </div>
  );
}
