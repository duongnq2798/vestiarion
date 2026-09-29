"use client";

import { ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";

interface VerificationResponse {
  /** `null` is "not checked" — see `VerificationResult` in `lib/ledger`. */
  valid?: boolean | null;
  checkedEntries?: number;
  brokenAt?: number;
  reason?: string;
  /** Configuration problems met on the way to the verdict; not about the chain. */
  warnings?: string[];
}

export interface Verdict {
  tone: "proof" | "refused" | "neutral";
  title: string;
  body: string;
}

/**
 * What a verification response says, pinned as a pure function. A request that
 * never reached a verdict is "not checked" — neutral, never "broken": calling
 * it broken would accuse the chain because the network or a key failed.
 */
export function verificationVerdict(result: VerificationResponse | null): Verdict | null {
  if (!result) return null;
  if (result.valid === true) {
    const entries = result.checkedEntries ?? 0;
    return { tone: "proof", title: "Chain intact", body: `${entries} signatures and ${Math.max(entries - 1, 0)} links verified.` };
  }
  if (result.valid === false) {
    return {
      tone: "refused",
      title: `Chain broken${result.brokenAt ? ` at #${String(result.brokenAt).padStart(4, "0")}` : ""}`,
      body: result.reason ?? "verification failed",
    };
  }
  return { tone: "neutral", title: "Not checked", body: `${result.reason ?? "no verdict was produced"}. This is not a finding about the chain.` };
}

export default function VerifyLedgerBadge({ orgSlug }: { orgSlug: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<VerificationResponse | null>(null);

  function verify() {
    startTransition(async () => {
      try {
        const response = await fetch(`/api/ledger/verify?org=${encodeURIComponent(orgSlug)}`);
        setResult((await response.json()) as VerificationResponse);
      } catch (error) {
        // A request that never arrived checked nothing. Calling that `false`
        // would accuse the chain of being broken because the network was.
        setResult({ valid: null, reason: error instanceof Error ? error.message : "Verification request failed" });
      }
    });
  }

  const verdict = verificationVerdict(result);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <Button variant="secondary" icon={<ShieldCheck />} loading={pending} onClick={verify} className="shrink-0">
        {pending ? "Checking every signature…" : result ? "Verify again" : "Verify hash chain"}
      </Button>
      <div aria-live="polite" className="min-w-0 flex-1">
        {verdict ? (
          <Callout tone={verdict.tone} title={verdict.title}>
            {verdict.body}
            {result?.warnings?.map((warning) => (
              <span key={warning} className="mt-1 block text-refused">
                Configuration: {warning}
              </span>
            ))}
          </Callout>
        ) : (
          !pending && <p className="py-2 text-[0.8125rem] text-ink-3">Not yet verified in this session.</p>
        )}
      </div>
    </div>
  );
}
