import AgentControls from "@/components/AgentControls";
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import { AuditLedger, DomainFilter, pad } from "@/components/vx/AuditLedger";
import { DOMAINS } from "@/components/vx/Glyphs";
import { Hash, Label } from "@/components/vx/Primitives";
import { EmptyState, PageHead, ProductShell } from "@/components/vx/Shell";
import type { Domain } from "@/components/vx/types";
import { ledgerPublicKeyPem, listLedgerEntries } from "@/lib/ledger";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const query = await searchParams;
  const [entries, dashboardStats] = await Promise.all([listLedgerEntries(300), stats()]);
  const domainValue = typeof query.domain === "string" ? query.domain : undefined;
  const domain = DOMAINS.includes(domainValue as Domain) ? (domainValue as Domain) : undefined;
  const shown = domain ? entries.filter((entry) => entry.domain === domain) : entries;
  const sinceValue = typeof query.since === "string" ? Number(query.since) : undefined;
  const since = Number.isFinite(sinceValue) ? sinceValue : undefined;
  const head = entries[0];
  const publicKey = ledgerPublicKeyPem();

  return (
    <ProductShell active="audit" day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt}>
      <PageHead
        title="Audit log"
        sub="Every decision is appended here, hash-linked to the one before it and signed with Ed25519. The summary stays readable; raw detail and cryptographic material remain inspectable."
        right={<AgentControls nextDay={dashboardStats.day + 1} headSeq={head?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
      />

      <section aria-label="Hash chain" className="mb-6 rounded-lg border border-line bg-surface p-4 sm:p-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <div><dt><Label>Entries</Label></dt><dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{entries.length}</dd></div>
          <div><dt><Label>Head</Label></dt><dd className="mt-1.5 font-mono text-[0.8125rem] text-ink">{head ? `#${pad(head.seq)}` : "—"}</dd></div>
          <div className="col-span-2 min-w-0"><dt><Label>Head hash</Label></dt><dd className="mt-1.5">{head ? <Hash value={head.hash} className="text-ink-2" /> : <span className="text-ink-3">—</span>}</dd></div>
        </dl>
        <div className="mt-4 border-t border-line pt-4"><VerifyLedgerBadge /></div>
      </section>

      <details className="mb-6 rounded-lg border border-line bg-surface p-4 text-xs text-ink-3">
        <summary className="cursor-pointer font-medium text-ink-2 hover:text-ink">Ledger signing public key</summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-ground p-3 font-mono text-ink-2">{publicKey}</pre>
      </details>

      {entries.length === 0 ? (
        <EmptyState title="The chain is empty" body={<>The first cycle writes entry <span className="font-mono text-ink">#0001</span>, links it to a genesis hash of zeros, and signs it with this deployment’s Ed25519 key.</>} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <DomainFilter active={domain} />
            <span className="font-mono text-xs text-ink-3">newest first · {shown.length} shown</span>
          </div>
          <AuditLedger entries={shown} since={since} />
        </>
      )}
    </ProductShell>
  );
}
