import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowRight, ExternalLink, FileSpreadsheet, Inbox, PenLine, Play, Plus, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/Card";
import { chipVariants } from "@/components/ui/chip";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Kbd } from "@/components/ui/Kbd";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Separator } from "@/components/ui/Separator";
import { Skeleton } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { Tooltip } from "@/components/ui/Tooltip";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import MilestoneIntake from "@/components/intake/MilestoneIntake";
import AgentControlsClient from "@/components/AgentControlsClient";
import AgentPauseControl from "@/components/AgentPauseControl";
import MembersPanel from "@/components/MembersPanel";
import { ReceiptControl, ReceiptLink } from "@/components/ReceiptControl";
import { EscrowPanel } from "@/components/EscrowPanel";
import { MilestoneEscrow } from "@/components/MilestoneEscrow";
import { ReceiptView } from "@/components/receipt/ReceiptView";
import { designReceipt } from "./receipt-fixture";
import MilestoneVerification from "@/components/MilestoneVerification";
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { AuditLedger, DomainFilter } from "@/components/vx/AuditLedger";
import { CycleReport } from "@/components/vx/CycleReport";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { InsightsCharts } from "@/components/vx/InsightsCharts";
import { PerformanceHistory } from "@/components/vx/PerformanceHistory";
import { ProvenanceBar } from "@/components/vx/Provenance";
import { RiskDial } from "@/components/vx/RiskDial";
import { AccountsList, BalanceTile, ForecastPanel, StatTile } from "@/components/vx/Treasury";
import { derivePerformanceScore } from "@/lib/agent/counterparty-history";
import { PageHead } from "@/components/vx/Shell";
import { ACCOUNTS, COUNTERPARTIES, DECISIONS, DESIGN_SLUG, FORECAST, HISTORY, INSIGHTS, INVITATIONS, LEDGER, MEMBERS, PROVENANCE } from "./fixtures";
import { FeedbackDemo, FormLab, OverlayDemo, TabsDemo } from "./Demos";
import { FrameDemo } from "./Screens";

export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
};

const SECTIONS = [
  ["foundations", "Foundations"],
  ["buttons", "Buttons"],
  ["badges", "Badges and chips"],
  ["surfaces", "Cards and callouts"],
  ["states", "Empty and loading"],
  ["data", "Tables and disclosure"],
  ["forms", "Forms"],
  ["overlays", "Overlays"],
  ["feedback", "Feedback and motion"],
  ["domain", "Domain components"],
  ["screens", "Screens"],
] as const;

// Full class names, so Tailwind sees each one in the source.
const COLOURS = [
  ["ground", "bg-ground"],
  ["surface", "bg-surface"],
  ["raised", "bg-raised"],
  ["line", "bg-line"],
  ["line-strong", "bg-line-strong"],
  ["ink", "bg-ink"],
  ["ink-2", "bg-ink-2"],
  ["ink-3", "bg-ink-3"],
  ["agent", "bg-agent"],
  ["agent-soft", "bg-agent-soft"],
  ["agent-line", "bg-agent-line"],
  ["proof", "bg-proof"],
  ["proof-soft", "bg-proof-soft"],
  ["proof-line", "bg-proof-line"],
  ["held", "bg-held"],
  ["held-soft", "bg-held-soft"],
  ["held-line", "bg-held-line"],
  ["refused", "bg-refused"],
  ["refused-soft", "bg-refused-soft"],
  ["refused-line", "bg-refused-line"],
] as const;

const SHADOWS = [
  ["control", "shadow-control", "fields"],
  ["surface", "shadow-surface", "cards at rest"],
  ["raised", "shadow-raised", "a card being hovered"],
  ["overlay", "shadow-overlay", "menus, dialogs, toasts"],
  ["brand", "shadow-brand", "the primary button"],
] as const;

const RADII = [
  ["rounded-md", "tags, chips, keys"],
  ["rounded-lg", "menu items, small controls"],
  ["rounded-xl", "buttons, fields, callouts"],
  ["rounded-2xl", "cards, dialogs"],
  ["rounded-full", "pills, avatars"],
] as const;

const BUTTON_VARIANTS = ["primary", "secondary", "ghost", "danger", "danger-solid", "link"] as const;
const TONES = ["neutral", "agent", "proof", "held", "refused", "simulated"] as const;
const CALLOUT_TONES = ["neutral", "agent", "proof", "held", "refused"] as const;

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className="scroll-mt-8">
      <SectionHeader id={`${id}-title`} title={title} meta={description} />
      <div className="mt-4 space-y-6">{children}</div>
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Eyebrow>{label}</Eyebrow>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/**
 * Every primitive in src/components/ui, in every state, on one page: the
 * reference for building a screen and the place to check a change by eye.
 * Development only — production answers 404.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <MotionProvider>
      <div className="min-h-dvh">
        <header className="border-b border-line bg-surface/80">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
            <Eyebrow className="text-agent">Vestiarion design system</Eyebrow>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-4xl">Every primitive, in every state</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">
              Radix UI for behaviour, Motion and CSS for movement, Sonner for toasts — all styled from the tokens in{" "}
              <code className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs">globals.css</code>. Import each piece from{" "}
              <code className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs">@/components/ui</code>. This page exists in development only.
            </p>
            <nav aria-label="Sections" className="mt-6 flex flex-wrap gap-1.5">
              {SECTIONS.map(([id, label]) => (
                <a key={id} href={`#${id}`} className={chipVariants()}>
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-6xl space-y-16 px-4 py-10 sm:px-6 lg:py-14">
          <Section id="foundations" title="Foundations" description="colour, elevation, shape, type">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {COLOURS.map(([name, background]) => (
                <div key={name} className="overflow-hidden rounded-xl border border-line bg-surface">
                  <div className={`h-14 ${background}`} />
                  <p className="px-3 py-2 font-mono text-xs text-ink-2">{name}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {SHADOWS.map(([name, shadow, use]) => (
                <div key={name} className={`rounded-2xl border border-line bg-surface p-4 ${shadow}`}>
                  <p className="font-mono text-xs font-semibold text-ink">shadow-{name}</p>
                  <p className="mt-1 text-xs text-ink-3">{use}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {RADII.map(([radius, use]) => (
                <div key={radius} className="flex items-center gap-3">
                  <span className={`size-12 shrink-0 border border-agent-line bg-agent-soft ${radius}`} />
                  <div>
                    <p className="font-mono text-xs font-semibold text-ink">{radius}</p>
                    <p className="text-xs text-ink-3">{use}</p>
                  </div>
                </div>
              ))}
            </div>
            <Card>
              <CardContent className="space-y-4">
                <Eyebrow>Geist Mono · captions and figures</Eyebrow>
                <p className="text-3xl font-semibold tracking-[-0.03em] text-ink">Money moves. Evidence remains.</p>
                <p className="max-w-[70ch] font-serif text-reasoning text-ink">
                  Newsreader carries the agent’s reasoning: “Paid INV-204 for 1,250.00 USDC because the purchase order matched and the counterparty screened clear on day 26.”
                </p>
                <p className="text-sm text-ink-2">Geist Sans carries the interface.</p>
              </CardContent>
            </Card>
          </Section>

          <Section id="buttons" title="Buttons" description="variant names intent; size md is 44px tall on phones">
            <Specimen label="Variants">
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ))}
            </Specimen>
            <Specimen label="Sizes">
              <Button size="sm">Small</Button>
              <Button>Medium</Button>
              <Button size="lg">Large</Button>
              <Tooltip content="Add a counterparty">
                <Button size="icon" variant="secondary" aria-label="Add a counterparty">
                  <Plus />
                </Button>
              </Tooltip>
              <Tooltip content="Remove">
                <Button size="icon-sm" variant="ghost" aria-label="Remove">
                  <Trash2 />
                </Button>
              </Tooltip>
            </Specimen>
            <Specimen label="States">
              <Button icon={<Play />}>Run day 27</Button>
              <Button loading icon={<Play />}>
                Running day 27…
              </Button>
              <Button variant="secondary" disabled>
                Disabled
              </Button>
              <Button asChild variant="secondary">
                <a href="#buttons">
                  A link that looks like a button <ArrowRight />
                </a>
              </Button>
              <Button variant="link">
                Full audit log <ExternalLink />
              </Button>
            </Specimen>
            <div className="focus-inverse flex flex-wrap items-center gap-3 rounded-2xl bg-agent p-5">
              <Button variant="inverse">Open console</Button>
              <span className="text-sm text-on-agent/80">The inverse button sits on an agent-blue band.</span>
            </div>
          </Section>

          <Section id="badges" title="Badges and chips" description="tone is always said in words too">
            <Specimen label="Tones">
              {TONES.map((tone) => (
                <Badge key={tone} tone={tone} dot>
                  {tone}
                </Badge>
              ))}
            </Specimen>
            <Specimen label="Small, and tags">
              <Badge size="sm" tone="agent" className="font-mono uppercase tracking-wide">
                llm
              </Badge>
              <Badge size="sm" tone="held" shape="tag" className="font-mono uppercase tracking-wider">
                risk changed
              </Badge>
              <Badge shape="tag">PO-100</Badge>
            </Specimen>
            <Specimen label="Filter chips (links)">
              <a href="#badges" aria-current="page" className={chipVariants({ selected: true })}>
                All
              </a>
              <a href="#badges" className={chipVariants()}>
                Payables
              </a>
              <a href="#badges" className={chipVariants()}>
                Treasury
              </a>
            </Specimen>
          </Section>

          <Section id="surfaces" title="Cards and callouts" description="one surface per thing; callouts stand apart">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <Eyebrow>Cash forecast · next 14 days</Eyebrow>
                  <CardTitle>Projected 18,420.00 USDC</CardTitle>
                  <CardDescription>A card with a header, a body and a footer.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ProgressBar value={64} label="Liquid share of obligations" />
                </CardContent>
                <CardFooter>
                  <Button variant="link">
                    Full audit log <ArrowRight />
                  </Button>
                </CardFooter>
              </Card>
              <Card asChild interactive>
                <a href="#surfaces" className="block p-5 sm:p-6">
                  <Eyebrow>Decisions logged</Eyebrow>
                  <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">163</p>
                  <p className="mt-2 text-sm text-ink-2">An interactive card lifts on hover.</p>
                </a>
              </Card>
              {(["held", "refused", "simulated", "agent"] as const).map((tone) => (
                <Card key={tone} tone={tone}>
                  <CardContent>
                    <p className="text-sm font-semibold text-ink capitalize">{tone}</p>
                    <p className="mt-1 text-sm text-ink-2">A card toned by what it holds.</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="grid gap-3">
              {CALLOUT_TONES.map((tone) => (
                <Callout key={tone} tone={tone} title={`${tone === "agent" ? "An" : "A"} ${tone} callout`}>
                  Blocks that stand apart from the page: a refusal, a warning, a recommendation.
                </Callout>
              ))}
            </div>
          </Section>

          <Section id="states" title="Empty and loading" description="what a view says before it has data">
            <EmptyState
              icon={<Inbox />}
              title="No invoices here"
              body="Add one by hand or import a CSV; the agent evaluates new invoices on its next cycle."
              action={<Button icon={<Plus />}>Add an invoice</Button>}
            />
            <Card>
              <CardContent className="space-y-3" aria-busy="true">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-5 w-3/5" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </CardContent>
            </Card>
            <Specimen label="Progress, spinners, keys, avatars">
              <div className="w-48 space-y-2">
                <ProgressBar label="Indeterminate" />
                <ProgressBar value={42} label="Determinate" />
              </div>
              <Spinner className="text-agent" />
              <span className="inline-flex items-center gap-1">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
              <Separator orientation="vertical" className="h-8" />
              <Avatar name="ada@example.com" />
              <Avatar name="Founding" tone="agent" shape="square" size="lg" />
            </Specimen>
          </Section>

          <Section id="data" title="Tables and disclosure" description="tables scroll inside their frame; disclosure is <details>">
            <Card className="overflow-hidden">
              <Table className="min-w-[32rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    ["ada@example.com", "Owner", "Sep 24, 2026"],
                    ["grace@example.com", "Admin", "Sep 27, 2026"],
                    ["alan@example.com", "Viewer", "Sep 28, 2026"],
                  ].map(([email, role, joined]) => (
                    <TableRow key={email}>
                      <TableCell>
                        <span className="flex items-center gap-2.5">
                          <Avatar name={email} size="sm" />
                          {email}
                        </span>
                      </TableCell>
                      <TableCell>{role}</TableCell>
                      <TableCell className="text-ink-2">{joined}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Disclosure summary="Score inputs">
              <p className="text-sm leading-relaxed text-ink-2">4 clean payments · 1 information request · 0 held or flagged. Pulled toward 50% until there is enough history to leave it.</p>
            </Disclosure>
            <Disclosure summary="Ledger signing public key · 9b03458d9a617871" defaultOpen>
              <pre className="overflow-x-auto rounded-lg bg-ground p-3 font-mono text-xs text-ink-2">-----BEGIN PUBLIC KEY-----{"\n"}MCowBQYDK2VwAyEA…{"\n"}-----END PUBLIC KEY-----</pre>
            </Disclosure>
          </Section>

          <Section id="forms" title="Forms" description="a refusal keeps your input; the echo shows exactly what arrived">
            <FormLab />
          </Section>

          <Section id="overlays" title="Overlays" description="focus is trapped and returned; Escape closes">
            <OverlayDemo />
          </Section>

          <Section id="feedback" title="Feedback and motion" description="toasts, tabs, and content that rises into view">
            <FeedbackDemo />
            <TabsDemo />
            <div className="grid gap-4 md:grid-cols-3">
              {["Observe", "Reason", "Enforce"].map((step, index) => (
                <Reveal key={step} delay={index * 60}>
                  <Card>
                    <CardContent>
                      <Eyebrow className="text-agent">0{index + 1}</Eyebrow>
                      <p className="mt-2 font-semibold text-ink">{step}</p>
                      <p className="mt-1 text-sm text-ink-2">Revealed once, as it scrolls into view.</p>
                    </CardContent>
                  </Card>
                </Reveal>
              ))}
            </div>
          </Section>

          <Section id="domain" title="Domain components" description="decisions, treasury, ledger and charts, from fixtures">
            <ProvenanceBar legs={PROVENANCE} />
            <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
              <BalanceTile accounts={ACCOUNTS} mode="live" />
              <StatTile label="Paid out to date" sub="2 settled on-chain">
                1,250.00
              </StatTile>
              <StatTile label="Decisions logged" href="/design#domain" sub="Every entry is hash-linked and signed">
                6
              </StatTile>
              <StatTile label="Needs you" tone="held" href="/design#domain" sub="Waiting for a person’s decision">
                2
              </StatTile>
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <AccountsList accounts={ACCOUNTS} />
              <ForecastPanel forecast={FORECAST} />
            </div>
            <div className="space-y-4">
              {DECISIONS.map((decision) => (
                <DecisionCard key={decision.id} decision={decision} orgSlug={DESIGN_SLUG} />
              ))}
            </div>
            <CycleReport entries={LEDGER} day={27} since={3} clockMode="simulate" completedAt={null} orgSlug={DESIGN_SLUG} />
            <DomainFilter orgSlug={DESIGN_SLUG} active="ap" />
            <AuditLedger entries={LEDGER} since={5} />
            <Card className="p-4 sm:p-6">
              <VerifyLedgerBadge orgSlug={DESIGN_SLUG} />
            </Card>
            <Card className="space-y-4 p-4 sm:p-6">
              <RiskDial risk="unscreened" baseline={null} effective={null} />
              <RiskDial risk="clear" baseline={5000} effective={5000} />
              <RiskDial risk="medium" baseline={5000} effective={2500} />
              <RiskDial risk="high" baseline={5000} effective={0} />
              <PerformanceHistory score={derivePerformanceScore(HISTORY).score} inputs={HISTORY} />
            </Card>
            <InsightsCharts data={INSIGHTS} />
            <InsightsCharts data={{ transfers: [], runs: [], snapshots: [], treasuryMoves: [], screenings: [] }} />
          </Section>

          <Section id="screens" title="Screens" description="the real components with made-up data — nothing here is saved">
            <Callout tone="held" title="These forms reach the real server actions">
              Without a signed-in member of a real workspace every submission is refused — which is how the refusal path is checked here: the message appears beside the form and what you typed stays.
            </Callout>
            <FrameDemo />
            <Card className="p-4 sm:p-6">
              <PageHead
                title="Treasury"
                sub="What the agent holds, what it decided, and why."
                right={<AgentControlsClient orgSlug={DESIGN_SLUG} nextDay={27} clockMode="simulate" leading={<AgentPauseControl orgSlug={DESIGN_SLUG} paused={false} canPause canResume />} />}
              />
              <PageHead
                title="Treasury, paused"
                sub="The same head while the agent is paused: Resume beside a disabled Run."
                right={<AgentControlsClient orgSlug={DESIGN_SLUG} nextDay={27} clockMode="simulate" paused leading={<AgentPauseControl orgSlug={DESIGN_SLUG} paused canPause canResume />} />}
              />
            </Card>
            <CounterpartyIntake orgSlug={DESIGN_SLUG} />
            <Card className="p-4 sm:p-6">
              <Tabs defaultValue="manual">
                <TabsList aria-label="Invoice intake">
                  <TabsTrigger value="manual">
                    <PenLine aria-hidden />
                    Enter one invoice
                  </TabsTrigger>
                  <TabsTrigger value="csv">
                    <FileSpreadsheet aria-hidden />
                    Import CSV
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                  <InvoiceIntake orgSlug={DESIGN_SLUG} counterparties={COUNTERPARTIES} />
                </TabsContent>
                <TabsContent value="csv" forceMount className="data-[state=inactive]:hidden">
                  <InvoiceCsvImport orgSlug={DESIGN_SLUG} />
                </TabsContent>
              </Tabs>
            </Card>
            <Card className="p-4 sm:p-6">
              <MilestoneIntake orgSlug={DESIGN_SLUG} contractors={COUNTERPARTIES.filter((counterparty) => counterparty.role !== "client")} />
            </Card>
            <Card className="p-4 sm:p-5">
              <Eyebrow>Milestone verification</Eyebrow>
              <MilestoneVerification orgSlug={DESIGN_SLUG} milestoneId="00000000-0000-4000-8000-00000000000a" verified={false} />
            </Card>
            <EscrowPanel orgSlug={DESIGN_SLUG} address={null} deploying={false} canSetUp />
            <EscrowPanel orgSlug={DESIGN_SLUG} address="0xE5c0000000000000000000000000000000000E5c" deploying={false} canSetUp />
            <Card className="space-y-3 p-4 sm:p-5">
              <Eyebrow>Milestone escrow, under a milestone&apos;s card</Eyebrow>
              <MilestoneEscrow
                orgSlug={DESIGN_SLUG}
                milestoneId="00000000-0000-4000-8000-00000000000c"
                requestId="00000000-0000-4000-8000-0000000000aa"
                defaultRefundDate="2026-10-31"
                minRefundDate="2026-10-02"
                maxRefundDate="2027-10-01"
                escrowReady
                canManage
                paid={false}
                refundable={false}
                payee="0x67C8000000000000000000000000000000000504"
                amount={2}
                lockable
                hold={null}
              />
              <MilestoneEscrow
                orgSlug={DESIGN_SLUG}
                milestoneId="00000000-0000-4000-8000-00000000000d"
                requestId="00000000-0000-4000-8000-0000000000ab"
                defaultRefundDate="2026-10-31"
                minRefundDate="2026-10-02"
                maxRefundDate="2027-10-01"
                payee="0x67C8000000000000000000000000000000000504"
                amount={2}
                lockable={false}
                escrowReady
                canManage
                paid={false}
                refundable
                hold={{ state: "funded", refundAfter: "2026-10-31T00:00:00Z", amount: 2, fundTxHash: `0x${"2a".repeat(32)}`, releaseTxHash: null, refundTxHash: null }}
              />
              <MilestoneEscrow
                orgSlug={DESIGN_SLUG}
                milestoneId="00000000-0000-4000-8000-00000000000e"
                requestId="00000000-0000-4000-8000-0000000000ac"
                defaultRefundDate="2026-10-31"
                minRefundDate="2026-10-02"
                maxRefundDate="2027-10-01"
                payee="0x67C8000000000000000000000000000000000504"
                amount={2}
                lockable={false}
                escrowReady
                canManage
                paid
                refundable={false}
                hold={{ state: "released", refundAfter: "2026-10-31T00:00:00Z", amount: 2, fundTxHash: `0x${"2a".repeat(32)}`, releaseTxHash: `0x${"3b".repeat(32)}`, refundTxHash: null }}
              />
            </Card>
            <Card className="space-y-3 p-4 sm:p-5">
              <Eyebrow>Payment receipt, on a paid payable&apos;s card</Eyebrow>
              <ReceiptControl orgSlug={DESIGN_SLUG} invoiceId="00000000-0000-4000-8000-00000000000b" shared={false} />
              <ReceiptControl orgSlug={DESIGN_SLUG} invoiceId="00000000-0000-4000-8000-00000000000b" shared />
            </Card>
            <DecisionCard
              decision={DECISIONS.find((decision) => decision.txHash) ?? DECISIONS[0]}
              orgSlug={DESIGN_SLUG}
              footerAction={
                <div className="space-y-2">
                  <ReceiptControl orgSlug={DESIGN_SLUG} invoiceId="00000000-0000-4000-8000-00000000000b" shared />
                  <ReceiptLink
                    url="https://www.vestiarion.xyz/receipt/vxr_kvtVqZq_uaT2ghKUNa3hfeooIjwAI3D9swSt8McVrQx"
                    message="Receipt shared. Copy the link now: it is shown only once."
                  />
                </div>
              }
            />
            <div className="mx-auto w-full max-w-2xl">
              <ReceiptView view={designReceipt()} />
            </div>
            <MembersPanel
              orgSlug={DESIGN_SLUG}
              members={MEMBERS}
              invitations={INVITATIONS}
              viewerId="design-ada"
              viewerRole="owner"
              assignable={["owner", "admin", "approver", "viewer"]}
              canDecide
              notifyEmail
            />
          </Section>
        </main>
      </div>
    </MotionProvider>
  );
}
