"use client";

import { CircleDashed, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { verifySignedLink, type EntryCheck, type SignedLink } from "@/lib/receipts/verify";

/**
 * The landing's latest decision, checked in the reader's own browser (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md
 * R3): the receipt verifier's signature-and-link half, over Web Crypto. The entry's body stays private, so this proves
 * that the workspace's key signed it and that it follows the entry before it, and says no more than that.
 */
export function checkSentence(check: EntryCheck, keyId: string | null): string {
  if (check.ok === true) {
    return `Verified in your browser: ${keyId ? `key ${keyId}` : "the workspace's key"} signed this entry, and it follows the entry before it in the chain.`;
  }
  return check.ok === false ? `Did not verify: ${check.reason}` : `Not checked here: ${check.reason}`;
}

export function SignatureCheck({ link, publicKeys }: { link: SignedLink; publicKeys: Record<string, string> }) {
  const [check, setCheck] = useState<EntryCheck | null>(null);
  const [checking, setChecking] = useState(false);

  async function run() {
    setChecking(true);
    try {
      setCheck(await verifySignedLink(link, publicKeys));
    } catch {
      setCheck({ ok: null, reason: "This browser could not run the check." });
    } finally {
      setChecking(false);
    }
  }

  const Icon = check?.ok === true ? ShieldCheck : check?.ok === false ? ShieldX : CircleDashed;
  return (
    <div className="grid gap-2.5">
      <Button size="sm" variant="secondary" className="justify-self-start" icon={<ShieldCheck />} loading={checking} onClick={run}>
        {check ? "Check it again" : "Check its signature"}
      </Button>
      <p aria-live="polite" className="min-h-0 text-xs leading-relaxed">
        {check && (
          <span className="flex items-start gap-1.5">
            <Icon aria-hidden className={check.ok === true ? "mt-px size-3.5 shrink-0 text-proof" : check.ok === false ? "mt-px size-3.5 shrink-0 text-refused" : "mt-px size-3.5 shrink-0 text-ink-3"} />
            <span className={check.ok === true ? "text-ink-2" : check.ok === false ? "text-refused" : "text-ink-3"}>{checkSentence(check, link.signing_key_id)}</span>
          </span>
        )}
      </p>
    </div>
  );
}
