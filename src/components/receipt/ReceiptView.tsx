import { CircleDashed, ShieldCheck, ShieldX } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Disclosure } from "@/components/ui/Disclosure";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Hash } from "@/components/vx/Primitives";
import { canonicalJson } from "@/lib/canonical-json";
import { chainById, homeChain, networkOfChain } from "@/lib/payee-chains";
import type { ReceiptView as ReceiptViewData } from "@/lib/platform/receipts";
import type { ReceiptFacts } from "@/lib/receipts/facts";
import type { EntryCheck } from "@/lib/receipts/verify";
import { BrowserCheck } from "./BrowserCheck";

/**
 * A shared payment receipt (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P5): what was paid,
 * where and how; the three checks, each with its result; and everything needed to check it again. It names
 * no one: no business, payee or person, and no reasoning.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "1 October 2026, 08:28 UTC", the same on the server and in every browser. */
function paidOn(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function routeText(facts: ReceiptFacts): string {
  const fee = facts.feeUsdc != null ? `, with a ${facts.feeUsdc} USDC fee` : "";
  if (facts.route === "gateway") return `From a Circle Gateway balance${fee}`;
  if (facts.route === "cctp") return `Through CCTP from Arc testnet${fee}`;
  return "A transfer on Arc testnet";
}

function CheckItem({ title, passed, children }: { title: string; passed: boolean | null; children: ReactNode }) {
  const Icon = passed === true ? ShieldCheck : passed === false ? ShieldX : CircleDashed;
  const tone = passed === true ? "text-proof" : passed === false ? "text-refused" : "text-ink-3";
  return (
    <li className="flex gap-3">
      <Icon className={`mt-0.5 size-5 shrink-0 ${tone}`} aria-hidden />
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold text-ink">
          {title}
          <span className="sr-only">{passed === true ? ": passes" : passed === false ? ": does not pass" : ": not checked"}</span>
        </h3>
        {children}
      </div>
    </li>
  );
}

function sentence(check: EntryCheck, passed: string): string {
  return check.ok === true ? passed : check.reason;
}

export function ReceiptView({ view }: { view: ReceiptViewData }) {
  const { facts, entry, checks } = view;
  const chain = chainById(facts.chain);
  // Three answers, not two: every check passes; one did not pass; or one could not be made just now (review #10).
  const failed = checks.signed.ok === false || checks.recorded.ok === false || checks.onChain.state === "mismatch";
  const unchecked = [checks.signed.ok === null, checks.recorded.ok === null, checks.onChain.state === "unreadable"].filter(Boolean).length;
  const headline = failed
    ? { tone: "refused" as const, text: "A check does not pass" }
    : unchecked === 0
      ? { tone: "proof" as const, text: "All three checks pass" }
      : { tone: "neutral" as const, text: unchecked === 1 ? "One check could not be made just now" : "Some checks could not be made just now" };
  const keyId = entry.signing_key_id;
  const shownKeys = keyId && view.publicKeys[keyId] ? { [keyId]: view.publicKeys[keyId] } : view.publicKeys;
  const body = canonicalJson({ actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail });

  return (
    <article className="space-y-6">
      <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow className="text-agent">Payment receipt</Eyebrow>
          <Badge tone={headline.tone} dot>
            {headline.text}
          </Badge>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
          {facts.amount} {facts.token} paid on {chain.label}
        </h1>
        <p className="mt-1 text-sm text-ink-2">{paidOn(facts.paidAt)}</p>
        <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-y-3">
          <dt className="mt-2 text-ink-3 first:mt-0 sm:mt-0">Paid to</dt>
          <dd className="break-all font-mono text-[0.8125rem] text-ink">{facts.payee}</dd>
          <dt className="mt-2 text-ink-3 first:mt-0 sm:mt-0">Route</dt>
          <dd className="text-ink">{routeText(facts)}</dd>
          <dt className="mt-2 text-ink-3 first:mt-0 sm:mt-0">{facts.route === "direct" ? "Transfer" : `Mint on ${chain.label}`}</dt>
          <dd>
            <Hash value={facts.txHash} href={`${chain.explorerTx}${facts.txHash}`} />
          </dd>
          {facts.sourceTxHash && (
            <>
              <dt className="mt-2 text-ink-3 first:mt-0 sm:mt-0">Burn on Arc testnet</dt>
              <dd>
                <Hash value={facts.sourceTxHash} href={`${homeChain(networkOfChain(facts.chain)).explorerTx}${facts.sourceTxHash}`} />
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
        <h2 className="text-base font-semibold text-ink">The checks</h2>
        <ol className="mt-4 space-y-5">
          <CheckItem title="Signed by the paying workspace" passed={checks.signed.ok}>
            <p className="text-sm text-ink-2">
              {sentence(
                checks.signed,
                `Ledger entry #${entry.seq} is signed with the workspace's key ${keyId ?? ""}. Its hash follows from its content, its signature and the hash of the entry before it.`
              )}
            </p>
            <BrowserCheck entry={entry} publicKeys={view.publicKeys} />
          </CheckItem>
          <CheckItem title="Recorded when it was paid" passed={checks.recorded.ok}>
            <p className="text-sm text-ink-2">
              {sentence(
                checks.recorded,
                `Entry #${view.records.seq}, written earlier in the same workspace's ledger and signed with its key ${view.records.signingKeyId ?? ""}, records this transaction. Its content stays private.`
              )}
            </p>
          </CheckItem>
          <CheckItem title={`On ${chain.label}`} passed={checks.onChain.state === "matches" ? true : checks.onChain.state === "mismatch" ? false : null}>
            <p className="text-sm text-ink-2">
              {checks.onChain.state === "matches"
                ? `Block ${checks.onChain.block} holds a transfer of ${facts.amount} ${facts.token} to the payee in this transaction.`
                : checks.onChain.state === "mismatch"
                  ? checks.onChain.reason
                  : `${chain.label} did not answer just now. The explorer shows the transaction.`}
            </p>
          </CheckItem>
        </ol>
      </section>

      <Disclosure summary="Check it yourself" summaryClassName="px-6 py-4 text-base font-semibold text-ink" contentClassName="px-6 pb-6">
        <div className="space-y-4 text-sm text-ink-2">
          <p>The workspace signed this entry into its ledger when it shared the receipt. Anyone can check it:</p>
          <ul className="list-disc space-y-1 pl-5 font-mono text-xs">
            <li>body_hash = sha256(the entry below, as JSON with its keys sorted)</li>
            <li>signature = Ed25519 over the 32 bytes of body_hash, by the key below</li>
            <li>hash = sha256(prev_hash || body_hash || signature)</li>
          </ul>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-3 font-mono text-xs text-ink">{body}</pre>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-mono text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
            {(
              [
                ["body_hash", entry.body_hash],
                ["signature", entry.signature],
                ["prev_hash", entry.prev_hash],
                ["hash", entry.hash],
                ["key id", keyId ?? "(none)"],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="mt-2 text-ink-3 first:mt-0 sm:mt-0">{label}</dt>
                <dd className="break-all text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          {Object.entries(shownKeys).map(([id, pem]) => (
            <pre key={id} className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-3 font-mono text-xs text-ink">
              {pem}
            </pre>
          ))}
        </div>
      </Disclosure>

      <p className="text-xs leading-5 text-ink-3">
        This receipt shows no names. The business that paid chose to share it, and can stop sharing it at any time. Vestiarion signs every payment
        decision into a hash-chained ledger.
      </p>
    </article>
  );
}
