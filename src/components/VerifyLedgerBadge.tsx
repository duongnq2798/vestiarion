"use client";

import { useState } from "react";

export default function VerifyLedgerBadge() {
  const [state, setState] = useState<"idle" | "checking" | "valid" | "invalid">("idle");
  const [detail, setDetail] = useState<string | null>(null);

  async function verify() {
    setState("checking");
    const res = await fetch("/api/ledger/verify");
    const data = await res.json();
    if (data.valid) {
      setState("valid");
      setDetail(`${data.checkedEntries} entries verified, hash chain and signatures intact.`);
    } else {
      setState("invalid");
      setDetail(`Broken at entry ${data.brokenAt}: ${data.reason}`);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={verify}
        className="rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-neutral-900"
      >
        {state === "checking" ? "Verifying…" : "Verify hash chain"}
      </button>
      {state === "valid" && <span className="text-sm text-emerald-400">✓ {detail}</span>}
      {state === "invalid" && <span className="text-sm text-rose-400">✗ {detail}</span>}
    </div>
  );
}
