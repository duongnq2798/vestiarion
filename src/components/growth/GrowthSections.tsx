import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/components/ui/cn";
import { utcDay, utcMinute } from "@/lib/copy";
import type { Definition } from "@/lib/growth/definitions";
import { REVIEW_WORDS, STAGE_WORDS, words, type ReviewStatus, type Stage } from "@/lib/growth/fields";
import { FUNNEL_STAGES, minutesToFirstDecision, NOT_ENOUGH_DATA, secondBillWithin7Days, workspaceSource, type LeadFunnel, type Ratio, type WorkspaceRow } from "@/lib/growth/metrics";
import type { Lead, LeadEventRow } from "@/lib/growth/read";
import { networkOf, networkProfile } from "@/lib/network";
import { funnelRows, type FunnelSide } from "@/lib/platform/funnel";
import type { SideKey } from "@/lib/platform/open-numbers";
import { LeadDecisionForm, LeadLinkForm, LeadStageForm } from "./GrowthForms";

/**
 * The founder dashboard's read-only pieces (/admin/growth), rendered on the server: tiles, the product funnel, the
 * workspaces, the breakdowns, the leads and their trails, the approval queue and the definitions. The forms inside
 * them are client components that post to the dashboard's own actions.
 */

const networkLabel = (network: string) => networkProfile(networkOf(network)).label;

export function Section({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-6 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {meta && <span className="text-[0.8125rem] text-ink-3">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** One figure: its value, and beneath it what it is made of. */
export function Tile({ label, value, detail, muted = false }: { label: string; value: ReactNode; detail?: ReactNode; muted?: boolean }) {
  return (
    <Card className="flex flex-col gap-1.5 p-4">
      <Eyebrow>{label}</Eyebrow>
      <p className={cn("text-xl font-semibold tracking-tight tabular-nums", muted ? "text-base text-ink-3" : "text-ink")}>{value}</p>
      {detail && <p className="text-xs leading-relaxed text-ink-3">{detail}</p>}
    </Card>
  );
}

/** A rate as a tile: the percentage with its parts, or "Not enough data yet" when its denominator is 0. */
export function RateTile({ label, rate, of }: { label: string; rate: Ratio; of: string }) {
  if (rate.value === null) return <Tile label={label} value={NOT_ENOUGH_DATA} detail={`0 ${of} so far.`} muted />;
  return <Tile label={label} value={`${Math.round(rate.value * 100)}%`} detail={`${rate.numerator} of ${rate.denominator} ${of}.`} />;
}

/** One network's funnel, customers apart from ours; never added to another network's. */
export function FunnelTable({ network, sides }: { network: string; sides: Record<SideKey, FunnelSide> | null }) {
  const label = networkLabel(network);
  if (!sides) return <p className="text-sm text-ink-3">{label}: the funnel could not be read.</p>;
  return (
    <Table label={`Product funnel on ${label}`} containerClassName="rounded-xl border border-line bg-surface" className="min-w-[18rem]">
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Customers</TableHead>
          <TableHead className="text-right">Ours</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {funnelRows(sides).map((row) => (
          <TableRow key={row.step}>
            <TableCell className="text-ink-2">{row.step}</TableCell>
            <TableCell className="text-right tabular-nums">{row.customers}</TableCell>
            <TableCell className="text-right tabular-nums text-ink-2">{row.ours}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const SECOND_BILL = { yes: "Yes", no: "No", too_early: "Too early" } as const;

function usdc(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function WorkspacesTable({ workspaces, now }: { workspaces: WorkspaceRow[]; now: Date }) {
  return (
    <Table label="Workspaces" containerClassName="rounded-xl border border-line bg-surface" className="min-w-[56rem] text-[0.8125rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="px-3">Created (UTC)</TableHead>
          <TableHead className="px-3">Workspace</TableHead>
          <TableHead className="px-3">Mode</TableHead>
          <TableHead className="px-3">Source</TableHead>
          <TableHead className="px-3 text-right">Min. to decision</TableHead>
          <TableHead className="px-3 text-right">Real bills</TableHead>
          <TableHead className="px-3">2nd bill in 7 days</TableHead>
          <TableHead className="px-3 text-right">Verdicts agreed</TableHead>
          <TableHead className="px-3">Live payments</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {workspaces.map((workspace) => {
          const minutes = minutesToFirstDecision(workspace);
          const second = secondBillWithin7Days(workspace, now);
          return (
            <TableRow key={workspace.orgId}>
              <TableCell className="whitespace-nowrap px-3 text-ink-2">{utcMinute(workspace.createdAt)}</TableCell>
              <TableCell className="px-3">
                <span className="font-mono text-xs">{workspace.slug}</span>
                <span className="block text-xs text-ink-3">{networkLabel(workspace.network)}</span>
              </TableCell>
              <TableCell className="px-3">
                <span className="flex flex-wrap gap-1">
                  <Badge size="sm" tone={workspace.mode === "live" ? "proof" : "simulated"}>
                    {workspace.mode}
                  </Badge>
                  {workspace.shadow && (
                    <Badge size="sm" tone="agent">
                      shadow
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className="px-3 text-ink-2">{workspaceSource(workspace) ?? <span className="text-ink-3">Unknown</span>}</TableCell>
              <TableCell className="px-3 text-right tabular-nums">{minutes === null ? <span className="text-ink-3">None yet</span> : minutes}</TableCell>
              <TableCell className="px-3 text-right tabular-nums">{workspace.realBills}</TableCell>
              <TableCell className="px-3">
                <Badge size="sm" tone={second === "yes" ? "proof" : second === "no" ? "neutral" : "simulated"}>
                  {SECOND_BILL[second]}
                </Badge>
              </TableCell>
              <TableCell className="px-3 text-right tabular-nums">
                {workspace.verdictsGiven === 0 ? <span className="text-ink-3">None</span> : `${workspace.verdictsAgreed} / ${workspace.verdictsGiven}`}
              </TableCell>
              <TableCell className="px-3 tabular-nums">
                {workspace.livePayments}
                {workspace.livePayments > 0 && (
                  <span className="block text-xs text-ink-3">
                    {usdc(workspace.liveUsdc)} USDC on {networkLabel(workspace.network)}, payment volume, not revenue
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const FUNNEL_HEADS: Record<"sourced" | (typeof FUNNEL_STAGES)[number], string> = {
  sourced: "Sourced",
  qualified: "Qualified",
  contacted: "Contacted",
  replied: "Replied",
  conversation: "Conversation",
  workspace_created: "Workspace",
  real_invoice_reviewed: "Real invoice",
  paid_pilot: "Paid pilot",
  paying_customer: "Paying",
};

export function BreakdownTable({ title, rows, label = words }: { title: string; rows: Array<{ key: string; funnel: LeadFunnel }>; label?: (key: string) => string }) {
  const columns = ["sourced", ...FUNNEL_STAGES] as const;
  return (
    <Table label={`Leads by ${title}`} containerClassName="rounded-xl border border-line bg-surface" className="min-w-[48rem] text-[0.8125rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="px-3">{title}</TableHead>
          {columns.map((column) => (
            <TableHead key={column} className="px-3 text-right">
              {FUNNEL_HEADS[column]}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="px-3 text-ink-2">{label(row.key)}</TableCell>
            {columns.map((column) => (
              <TableCell key={column} className="px-3 text-right tabular-nums">
                {row.funnel[column]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const STAGE_TONE = (stage: Stage) => (stage === "lost" || stage === "disqualified" ? "refused" : stage === "paying_customer" || stage === "paid_pilot" ? "proof" : "neutral");
const REVIEW_TONE: Record<ReviewStatus, "held" | "proof" | "refused"> = { needs_review: "held", approved_to_contact: "proof", rejected: "refused" };

/** An address shown as text with its host as the link's words; only http(s), as the import allows. */
function Evidence({ url }: { url: string | null }) {
  if (!url || !/^https?:\/\//i.test(url)) return <span className="text-ink-3">None</span>;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    return <span className="text-ink-3">None</span>;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-agent underline-offset-4 hover:underline">
      {host}
    </a>
  );
}

function History({ events, viewer, slugs }: { events: LeadEventRow[]; viewer: string; slugs: Record<string, string> }) {
  if (events.length === 0) return <p className="text-xs text-ink-3">No changes logged.</p>;
  const value = (event: LeadEventRow, v: string | null) => {
    if (v === null) return "none";
    if (event.field === "org_id") return slugs[v] ?? `${v.slice(0, 8)}…`;
    if (event.field === "stage" || event.field === "created") return STAGE_WORDS[v as Stage] ?? v;
    return words(v);
  };
  return (
    <ol className="space-y-1.5 text-xs text-ink-2">
      {events.map((event) => (
        <li key={event.id} className="flex flex-wrap gap-x-2">
          <span className="whitespace-nowrap font-mono text-ink-3">{utcMinute(event.at)}</span>
          <span>
            {event.field === "created" ? `Added at ${value(event, event.new_value)}` : `${words(event.field)}: ${value(event, event.old_value)} → ${value(event, event.new_value)}`}
            {event.note ? ` · “${event.note}”` : ""}
            {event.by_user ? (event.by_user === viewer ? " · by you" : ` · by team member ${event.by_user.slice(0, 8)}`) : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function LeadCard({ lead, events, campaignName, viewer, slugs }: { lead: Lead; events: LeadEventRow[]; campaignName: string | null; viewer: string; slugs: Record<string, string> }) {
  const workspace = lead.org_id ? (slugs[lead.org_id] ?? null) : null;
  return (
    <Disclosure
      summary={
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-ink">{lead.business_name}</span>
          <Badge size="sm" tone={STAGE_TONE(lead.stage)}>
            {STAGE_WORDS[lead.stage]}
          </Badge>
          <Badge size="sm" tone={REVIEW_TONE[lead.review_status as ReviewStatus] ?? "held"}>
            {REVIEW_WORDS[lead.review_status as ReviewStatus] ?? lead.review_status}
          </Badge>
          <span className="text-xs text-ink-3">
            {words(lead.source)}
            {lead.segment ? ` · ${words(lead.segment)}` : ""}
            {campaignName ? ` · ${campaignName}` : ""}
            {workspace ? ` · ${workspace}` : ""}
          </span>
        </span>
      }
    >
      <div className="space-y-4 pt-1">
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-ink-3">Company</dt>
            <dd className="text-ink-2">
              <Evidence url={lead.company_url} />
              {lead.geography ? ` · ${lead.geography}` : ""}
              {lead.size_estimate ? ` · ${lead.size_estimate}${lead.size_uncertain ? " (uncertain)" : ""}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">Contact</dt>
            <dd className="text-ink-2">
              {[lead.prospect_role, lead.contact_channel && words(lead.contact_channel), lead.contact_handle].filter(Boolean).join(" · ") || "None recorded"}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">Added</dt>
            <dd className="text-ink-2">{utcDay(lead.created_at)}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Dedupe key</dt>
            <dd className="font-mono text-ink-2">{lead.dedupe_key}</dd>
          </div>
          {lead.notes && (
            <div className="sm:col-span-2">
              <dt className="text-ink-3">Notes</dt>
              <dd className="whitespace-pre-wrap text-ink-2">{lead.notes}</dd>
            </div>
          )}
        </dl>
        <LeadStageForm leadId={lead.id} stage={lead.stage} />
        <LeadLinkForm leadId={lead.id} workspace={workspace} />
        <div className="space-y-2">
          <Eyebrow>History</Eyebrow>
          <History events={events} viewer={viewer} slugs={slugs} />
        </div>
      </div>
    </Disclosure>
  );
}

export function ApprovalCard({ lead }: { lead: Lead }) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium text-ink">{lead.business_name}</h3>
        <span className="text-xs text-ink-3">
          {words(lead.source)}
          {lead.contact_channel ? ` · via ${words(lead.contact_channel)}` : ""}
        </span>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-ink-3">Signal</dt>
          <dd className="whitespace-pre-wrap text-ink-2">{lead.signal ?? "None recorded"}</dd>
        </div>
        {/* An inbound lead, such as a guided setup request from /studios, carries who asked and what they said here. */}
        {lead.contact_handle && (
          <div>
            <dt className="text-ink-3">Contact</dt>
            <dd className="break-words text-ink-2">{lead.contact_handle}</dd>
          </div>
        )}
        {lead.company_url && (
          <div>
            <dt className="text-ink-3">Company</dt>
            <dd className="text-ink-2">
              <Evidence url={lead.company_url} />
            </dd>
          </div>
        )}
        {lead.notes && (
          <div className="sm:col-span-2">
            <dt className="text-ink-3">Notes</dt>
            <dd className="whitespace-pre-wrap break-words text-ink-2">{lead.notes}</dd>
          </div>
        )}
        {lead.source_detail && (
          <div className="sm:col-span-2">
            <dt className="text-ink-3">Source detail</dt>
            <dd className="break-words text-ink-2">{lead.source_detail}</dd>
          </div>
        )}
        <div>
          <dt className="text-ink-3">Evidence</dt>
          <dd className="text-ink-2">
            <Evidence url={lead.evidence_url} />
            {lead.evidence_date ? ` · ${lead.evidence_date}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Confidence</dt>
          <dd className="text-ink-2">{lead.evidence_confidence ?? "Not given"}</dd>
        </div>
        {lead.inferred_pain && (
          <div className="sm:col-span-2">
            <dt className="text-ink-3">Inferred pain</dt>
            <dd className="whitespace-pre-wrap text-ink-2">{lead.inferred_pain}</dd>
          </div>
        )}
        <div className="sm:col-span-2">
          <dt className="text-ink-3">Draft message</dt>
          <dd className="mt-1 whitespace-pre-wrap rounded-lg border border-line bg-raised/40 p-3 text-ink-2">{lead.draft_message ?? "None written"}</dd>
        </div>
      </dl>
      <LeadDecisionForm leadId={lead.id} />
    </Card>
  );
}

/** A row of filter links: the chosen one marked, the first (`allLabel`, "All") clearing it. */
export function FilterLinks({
  label,
  options,
  chosen,
  href,
  allLabel = "All",
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  chosen: string | null;
  href: (value: string | null) => string;
  allLabel?: string;
}) {
  const link = (value: string | null, text: string) => (
    <Link
      key={value ?? "all"}
      href={href(value)}
      aria-current={chosen === value ? "true" : undefined}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors duration-150 ease-standard",
        chosen === value ? "border-agent-line bg-agent-soft text-agent" : "border-line-strong bg-surface text-ink-2 hover:text-ink"
      )}
    >
      {text}
    </Link>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-1 text-xs text-ink-3">{label}</span>
      {link(null, allLabel)}
      {options.map((option) => link(option.value, option.label))}
    </div>
  );
}

export function Definitions({ definitions }: { definitions: readonly Definition[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {definitions.map((definition) => (
        <Card key={definition.metric} className="p-4">
          <h3 className="text-sm font-semibold text-ink">{definition.metric}</h3>
          <dl className="mt-2 space-y-1.5 text-xs leading-relaxed">
            {(
              [
                ["Source", definition.source],
                ["Calculation", definition.calculation],
                ["Window", definition.window],
                ["Dedupe", definition.dedupe],
                ["Limits", definition.limits],
              ] as const
            ).map(([term, text]) => (
              <div key={term}>
                <dt className="inline font-medium text-ink-2">{term}: </dt>
                <dd className="inline text-ink-3">{text}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
    </div>
  );
}
