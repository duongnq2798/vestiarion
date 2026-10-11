"use client";

import { useEffect, useState } from "react";
import { verifyEntry, type EntryCheck, type PublicLedgerRow } from "@/lib/receipts/verify";

const pad = (seq: number) => `#${String(seq).padStart(4, "0")}`;

/**
 * What the browser's check says: the count while it runs, then that every entry verifies, or how many do and what is
 * wrong with each that does not. Pure, so the words are tested without a browser.
 */
export function browserCheckWords(total: number, results: Array<{ seq: number; check: EntryCheck }> | null): { line: string; problems: string[] } {
  const count = total === 1 ? "1 entry" : `${total} entries`;
  if (results === null) return { line: `Checking ${count} again in your browser…`, problems: [] };
  const problems = results.flatMap(({ seq, check }) =>
    check.ok === true ? [] : [`Entry ${pad(seq)}: ${check.ok === false ? check.reason : `not checked here. ${check.reason}`}`]
  );
  if (problems.length === 0) return { line: `Checked again in your browser: ${total === 1 ? "it verifies" : `all ${total} verify`}.`, problems };
  const good = results.length - problems.length;
  return { line: `Checked again in your browser: ${good} of ${count} ${good === 1 ? "verifies" : "verify"}.`, problems };
}

/**
 * A payment's evidence, its entries checked again in the reader's browser (docs/superpowers/specs/2026-10-10-evidence-
 * chain-design.md E2.9): the receipt page's verifier over Web Crypto, each entry alone — its body hash, its signature
 * and its chain hash from its `prev_hash` — so the page does not only vouch for itself.
 */
export function EvidenceBrowserCheck({ entries, publicKeys }: { entries: PublicLedgerRow[]; publicKeys: Record<string, string> }) {
  const [results, setResults] = useState<Array<{ seq: number; check: EntryCheck }> | null>(null);

  useEffect(() => {
    let current = true;
    Promise.all(
      entries.map((entry) =>
        verifyEntry(entry, publicKeys).then(
          (check) => ({ seq: entry.seq, check }),
          () => ({ seq: entry.seq, check: { ok: null, reason: "This browser could not run the check." } as EntryCheck })
        )
      )
    ).then((checked) => current && setResults(checked));
    return () => {
      current = false;
    };
  }, [entries, publicKeys]);

  if (entries.length === 0) return null;
  const { line, problems } = browserCheckWords(entries.length, results);
  return (
    <div className="text-xs text-ink-2" aria-live="polite">
      <p>{line}</p>
      {problems.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
