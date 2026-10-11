import { Download } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EvidenceAccess, EvidenceChainView, evidenceSub } from "@/components/vx/EvidenceChain";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { evidenceLinkLabel } from "@/lib/evidence-paths";
import { readEvidence } from "@/lib/evidence-read";
import { stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Payment evidence" };

type EvidencePageProps = {
  params: Promise<{ slug: string; kind: string; id: string }>;
};

/**
 * Why it was paid (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E1): one payable's or milestone's
 * evidence, link by link, for every member of its workspace. Read-only: its one action is the download. A receivable,
 * an id that is not one, or a record the workspace does not hold is the workspace's not-found page.
 */
export default async function EvidencePage({ params }: EvidencePageProps) {
  const { slug, kind, id } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [read, dashboardStats] = await Promise.all([readEvidence(kind, id), stats()]);
    if (!read) notFound();
    const { chain } = read;
    const { subject } = chain;
    const download = `/api/evidence?org=${encodeURIComponent(slug)}&kind=${subject.kind}&id=${subject.id}`;

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={evidenceLinkLabel(subject.paid)}
          sub={evidenceSub(subject)}
          right={
            <div className="flex shrink-0 items-center gap-3">
              <DocsLink href="/docs/guides/evidence" topic="why a payment was paid" />
              <Button asChild variant="secondary" size="sm">
                <a href={download} download>
                  <Download aria-hidden />
                  Download evidence
                </a>
              </Button>
            </div>
          }
        />
        {!subject.paid && (
          <Callout className="mb-6">
            {subject.closed
              ? subject.kind === "invoice"
                ? "Not paid: a person rejected this bill. This is its evidence as it stands."
                : "Not paid: a person closed this milestone without paying it. This is its evidence as it stands."
              : "Not paid yet. This is the chain so far, read-only: nothing on this page pays, approves or changes anything."}
          </Callout>
        )}
        <EvidenceChainView chain={chain} orgSlug={slug} publicKeys={read.publicKeys} />
        <div className="mt-8">
          <EvidenceAccess kind={subject.kind} receipt={read.receipt?.state ?? null} role={access.membership.role} canShare={can(access.membership.role, "records.write")} />
        </div>
      </ProductShell>
    );
  });
}
