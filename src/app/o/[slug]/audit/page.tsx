import type { Metadata } from "next";
import Link from "next/link";
import AgentControls from "@/components/AgentControls";
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import { AuditLedger, DomainFilter, pad } from "@/components/vx/AuditLedger";
import { DOMAINS } from "@/components/vx/Glyphs";
import { ArrowRight, ScrollText, SearchX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Hash } from "@/components/vx/Primitives";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import type { Domain } from "@/components/vx/types";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { ledgerEntryCount, ledgerPublicKeyId, ledgerPublicKeyPem, ledgerReadWarnings, listLedgerEntries, listLedgerEntryPage } from "@/lib/ledger";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("audit") };

type AuditSearchParams = Promise<{
  domain?: string | string[];
  before?: string | string[];
  since?: string | string[];
}>;

type AuditPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: AuditSearchParams;
};

export default async function AuditPage({ params, searchParams }: AuditPageProps) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const query = await searchParams;
    const domainValue = typeof query.domain === "string" ? query.domain : undefined;
    const domain = DOMAINS.includes(domainValue as Domain) ? (domainValue as Domain) : undefined;
    const beforeValue = typeof query.before === "string" ? Number(query.before) : undefined;
    const before = Number.isSafeInteger(beforeValue) && Number(beforeValue) > 0 ? Number(beforeValue) : undefined;
    const [entries, headEntries, totalEntries, dashboardStats] = await Promise.all([
      listLedgerEntryPage({ before, domain, limit: 100 }),
      listLedgerEntries(1),
      ledgerEntryCount(),
      stats(),
    ]);
    const shown = entries;
    const sinceValue = typeof query.since === "string" ? Number(query.since) : undefined;
    const since = Number.isFinite(sinceValue) ? sinceValue : undefined;
    const head = headEntries[0];
    const hasOlder = entries.length === 100;
    const publicKey = ledgerPublicKeyPem();
    const keyId = ledgerPublicKeyId();
    const keyWarnings = ledgerReadWarnings();

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("audit")}
          sub="Every decision is appended here, hash-linked to the one before it and signed with Ed25519. The summary stays readable; raw detail and cryptographic material remain inspectable."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={head?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />

        <Card asChild className="mb-6 p-4 sm:p-6">
          <section aria-label="Hash chain">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <div>
                <dt><Eyebrow>Entries</Eyebrow></dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{totalEntries}</dd>
              </div>
              <div>
                <dt><Eyebrow>Head</Eyebrow></dt>
                <dd className="mt-1.5 font-mono text-[0.8125rem] text-ink">{head ? `#${pad(head.seq)}` : "—"}</dd>
              </div>
              <div className="col-span-2 min-w-0">
                <dt><Eyebrow>Head hash</Eyebrow></dt>
                <dd className="mt-1 flex items-center gap-1">
                  {head ? (
                    <>
                      <Hash value={head.hash} className="text-ink-2" />
                      <CopyButton value={head.hash} label="Copy the head hash" />
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="mt-4 border-t border-line pt-4">
              <VerifyLedgerBadge orgSlug={slug} />
            </div>
          </section>
        </Card>

        {keyWarnings.length > 0 && (
          <Callout tone="refused" title="Ledger key configuration needs attention" className="mb-6">
            <ul className="mt-1 list-disc space-y-1 pl-5 font-mono text-xs text-refused">
              {keyWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="mt-3 text-ink-2">
              The entries below are shown from the database regardless. A key that cannot be read is a
              configuration problem, not a finding about the chain.
            </p>
          </Callout>
        )}

        <Disclosure
          className="mb-6"
          summary={
            <span>
              Ledger signing public key
              {keyId ? (
                <>
                  {" "}
                  · <span className="font-mono text-ink-2">{keyId}</span>
                </>
              ) : null}
            </span>
          }
          contentClassName="text-xs text-ink-3"
        >
          {publicKey ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-ground p-3 font-mono text-ink-2">{publicKey}</pre>
          ) : (
            <p className="rounded-xl bg-ground p-3">
              This organization has no readable ledger key, so signatures on the entries below cannot
              be checked here. The key that signed them has to be stored on the organization — for the
              founding organization, <span className="font-mono text-ink-2">npm run org:adopt-env</span>.
              Nothing about the chain is known to be wrong — it is unverified, which is a different
              statement.
            </p>
          )}
        </Disclosure>

        {totalEntries === 0 ? (
          <EmptyState titleAs="h2" icon={<ScrollText />} title="The chain is empty" body={<>The first cycle writes entry <span className="font-mono text-ink">#0001</span>, links it to a genesis hash of zeros, and signs it with this deployment’s Ed25519 key.</>} />
        ) : shown.length === 0 ? (
          <EmptyState titleAs="h2" icon={<SearchX />} title="No entries in this view" body="Choose another domain or return to the newest entries." />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <DomainFilter active={domain} orgSlug={slug} />
              <span className="font-mono text-xs text-ink-3">newest first · {shown.length} shown</span>
            </div>
            <AuditLedger entries={shown} since={since} />
            {hasOlder && (
              <div className="mt-4 flex justify-center">
                <Button asChild variant="secondary" size="sm">
                  <Link href={orgHref(slug, `/audit?before=${entries.at(-1)!.seq}${domain ? `&domain=${domain}` : ""}`)}>
                    Older entries
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
              </div>
            )}
          </>
        )}
      </ProductShell>
    );
  });
}
