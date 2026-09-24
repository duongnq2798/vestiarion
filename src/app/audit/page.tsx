import AgentControls from "@/components/AgentControls";
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import { listLedgerEntries, ledgerPublicKeyPem } from "@/lib/ledger";

export const dynamic = "force-dynamic";

const domainColors: Record<string, string> = {
  ap: "border-sky-800",
  ar: "border-sky-800",
  contractor: "border-violet-800",
  treasury: "border-emerald-800",
  compliance: "border-rose-800",
  system: "border-neutral-700",
};

export default async function AuditPage() {
  const entries = await listLedgerEntries(300);
  const pubKey = ledgerPublicKeyPem();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-50">Audit Log</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Every decision the agent makes — including the reasoning it used and the balances it
            saw — is appended to a hash-chained, Ed25519-signed ledger. This is the continuous
            euthyna: a reviewer can replay why the agent acted, not just that a balance moved.
          </p>
        </div>
        <AgentControls />
      </div>

      <VerifyLedgerBadge />

      <details className="rounded-lg border border-neutral-800 p-4 text-xs text-neutral-500">
        <summary className="cursor-pointer text-neutral-400">Ledger signing public key</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{pubKey}</pre>
      </details>

      <div className="flex flex-col gap-3">
        {entries.map((e) => (
          <div
            key={e.id}
            className={`rounded-lg border-l-4 bg-neutral-900/40 p-4 ${
              domainColors[e.domain] ?? "border-neutral-700"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
              <span>
                #{e.seq} · {e.actor} · {e.domain}
              </span>
              <span>{new Date(e.ts).toLocaleString()}</span>
            </div>
            <p className="mt-1 text-sm text-neutral-100">{e.summary}</p>
            <details className="mt-2 text-xs text-neutral-500">
              <summary className="cursor-pointer">detail + hash</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(e.detail, null, 2)}
              </pre>
              <div className="mt-1 font-mono break-all">hash: {e.hash}</div>
              <div className="font-mono break-all">prev: {e.prevHash}</div>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}
