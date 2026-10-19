import { ArrowRight, ArrowUpRight, Check, Play, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { Reveal } from "@/components/ui/Reveal";
import { BrandMark, isWordmark, type Brand } from "@/components/vx/BrandMarks";
import { GitHubMark } from "@/components/vx/SiteChrome";
import { videoFor } from "@/lib/docs/videos";
import { ARC_URL, CIRCLE_URL } from "@/lib/site-links";
import { landingPrefetch } from "./prefetch";

const REPOSITORY = "https://github.com/duongnq2798/vestiarion";

/** Where "Explore all integrations" leads: every tool side by side, with what it reads, writes and never does. */
export const ALL_INTEGRATIONS = "/docs/guides/integrations";

/**
 * The tools Vestiarion connects to (docs/superpowers/specs/2026-10-18-landing-integrations-workflow-design.md, after
 * 2026-10-16-landing-integrations-design.md; the marks: 2026-10-07-brand-marks-design.md and
 * 2026-10-12-integration-marks-design.md). Three levels: the two accounting tools a business pays its bills from, each
 * with what comes in and what goes back, and Xero's loop step by step; the other tools, compact, each saying only what
 * is particular to it; and what every payment runs on, Arc and Circle, apart from the tools a business connects.
 *
 * Every sentence was checked against the tool's guide and code, so a read-only connector says so, a write-back says
 * who allows it, and nothing says a tool approves or pays. Each tool links to its guide, which is how a visitor learns
 * to connect it: there is no connect flow before sign-in. "Built on" and "works with", never "partners", "powered by"
 * or "trusted by": none of these companies vouches for Vestiarion.
 */

interface Featured {
  brand: Brand;
  name: string;
  /** How it connects: read-only, or what it writes back. */
  reach: string;
  comesIn: string;
  goesBack: string;
  href: string;
  /** The guide's walkthrough film, when it has one. */
  watch?: { href: string; duration: string };
  /** What a visitor should know before counting on it. */
  status?: string;
}

const QUICKBOOKS_VIDEO = videoFor("/docs/guides/quickbooks");

export const FEATURED: readonly [Featured, Featured] = [
  {
    brand: "xero",
    name: "Xero",
    reach: "Reads and books back",
    comesIn: "Approved bills with an amount due, every 15 minutes.",
    goesBack: "Each payment, booked against its bill once a person approves the entry.",
    href: "/docs/guides/xero",
    // The Xero guide's own film, recorded in Xero's demo company (it is not in GUIDE_VIDEOS, which has one per flow).
    watch: { href: "/docs/guides/xero#watch-it", duration: "1:52" },
  },
  {
    brand: "quickbooks-lockup",
    name: "QuickBooks Online",
    reach: "Read-only",
    comesIn: "Bills with a balance to pay, every 15 minutes and sooner on a change.",
    goesBack: "Nothing yet: Vestiarion writes nothing to QuickBooks.",
    href: "/docs/guides/quickbooks",
    ...(QUICKBOOKS_VIDEO ? { watch: { href: QUICKBOOKS_VIDEO.watch, duration: QUICKBOOKS_VIDEO.duration } } : {}),
    status: "Sandbox companies for now",
  },
];

/** Xero's loop as the product runs it: the supported workflow, not one payment's record. */
export const XERO_FLOW: ReadonlyArray<{ mark: "xero" | "rules" | "arc"; title: string; body: string }> = [
  { mark: "xero", title: "A bill comes in", body: "Approved in Xero, it waits for review. You add the ones to pay." },
  {
    mark: "rules",
    title: "Your rules check it",
    body: "The agent proposes; code checks your limits and approvals. What fails waits for a person.",
  },
  { mark: "arc", title: "It is paid on Arc", body: "In USDC or EURC, with a transaction anyone can check." },
  { mark: "xero", title: "Xero is updated", body: "Once you approve the entry, the payment is booked against the bill." },
];

/** A tool Vestiarion's own code connects to, beyond the two above. */
interface Tool {
  /** Its owner's mark; GitHub's is drawn, and Invoice Capture is Vestiarion's own extension, with its own icon. */
  mark: Brand | "github" | "invoice-capture";
  name: string;
  /** The job it does for the business. */
  kind: string;
  body: string;
  /** The tool's guide. */
  href: string;
  /** The mark's height, so marks of different shapes look the same size; 22 when not set. */
  size?: number;
}

export const MORE_TOOLS: readonly Tool[] = [
  {
    mark: "zohobooks-lockup",
    name: "Zoho Books",
    kind: "Accounting",
    body: "Open, overdue and partly paid bills come in for review. Read-only.",
    href: "/docs/guides/zohobooks",
    size: 24,
  },
  {
    mark: "hubspot",
    name: "HubSpot",
    kind: "Sales and CRM",
    body: "Won deals come in to plan collections. Once you allow it, receipts go back on the deal.",
    href: "/docs/guides/hubspot",
  },
  {
    mark: "pipedrive-lockup",
    name: "Pipedrive",
    kind: "Sales and CRM",
    body: "Won deals by webhook. Once allowed, receipts for Arc mainnet payments go back.",
    href: "/docs/guides/pipedrive",
    size: 20,
  },
  {
    mark: "zohocrm-lockup",
    name: "Zoho CRM",
    kind: "Sales and CRM",
    body: "Won deals come in with their accounts and contacts. Read-only.",
    href: "/docs/guides/zohocrm",
    size: 24,
  },
  {
    mark: "asana-lockup",
    name: "Asana",
    kind: "Delivered work",
    body: "A completed task is paid only after a person accepts it against its criteria.",
    href: "/docs/guides/asana",
    size: 18,
  },
  {
    mark: "github",
    name: "GitHub",
    kind: "Delivered work",
    body: "A paid pull request gets a comment with its transaction. The app never merges or pays.",
    href: "/docs/guides/github",
  },
  {
    mark: "slack",
    name: "Slack",
    kind: "Team chat",
    body: "The agent's decisions in a channel you pick. Ask what's waiting, or pause it.",
    href: "/docs/guides/slack",
  },
  {
    mark: "telegram",
    name: "Telegram",
    kind: "Team chat",
    body: "Decisions in your own chat, and bills you send it to add. The bot never pays.",
    href: "/docs/guides/telegram",
  },
  {
    mark: "invoice-capture",
    name: "Invoice Capture",
    kind: "Chrome extension",
    body: "Send an invoice from a supplier's portal, web mail or PDF as a draft a person adds. It never pays.",
    href: "/docs/guides/invoice-capture",
  },
];

/**
 * What Vestiarion is built on (docs/superpowers/specs/2026-10-16-landing-arc-circle-design.md): Arc, where its payments
 * are made, and Circle, whose wallets hold the treasury and send them, each drawn larger than a tool a business connects,
 * with what the product does on it and links to the evidence: the open numbers, the README's mainnet proof and Circle
 * table, the code, and each company's own site. Every fact is the README's ("Circle integrations", "Mainnet proof"),
 * and the testnet-only ones say so. "Built on" and "built with", never "powered by" or "partner": neither vouches for
 * Vestiarion.
 */
const FOUNDATIONS: ReadonlyArray<{
  brand: Brand;
  name: string;
  role: string;
  body: string;
  facts: readonly string[];
  links: ReadonlyArray<{ href: string; label: string }>;
  site: { href: string; label: string };
}> = [
  {
    brand: "arc",
    name: "Arc",
    role: "Where payments are made",
    body: "The agent's payments are made on Arc, each with a transaction anyone can check on Arc's explorer.",
    facts: ["Arc testnet for shadow mode and trials, Arc mainnet for real USDC"],
    links: [
      { href: "/open", label: "See the payments" },
      { href: `${REPOSITORY}#mainnet-proof`, label: "Mainnet proof" },
    ],
    site: { href: ARC_URL, label: "arc.io" },
  },
  {
    brand: "circle",
    name: "Circle",
    role: "Wallets and money movement",
    body: "Circle's wallets hold each workspace's treasury and send every payment the agent is allowed to make.",
    facts: [
      "Developer-Controlled Wallets for treasury and agent wallets, transfers and balances",
      "Modular Wallets for passkey wallets: an owner's treasury on Arc mainnet, and payees'",
      "CCTP, Gateway, Gas Station, USYC and EURC swaps on Arc testnet",
    ],
    links: [
      { href: `${REPOSITORY}#circle-integrations`, label: "Circle products we use" },
      { href: `${REPOSITORY}/blob/main/src/lib/circle/liveProvider.ts`, label: "Read the code" },
    ],
    site: { href: CIRCLE_URL, label: "circle.com" },
  },
];

/** A mark with its name: a mark that spells the name stands in its place, the name kept for screen readers. */
function Named({ brand, name, size }: { brand: Brand; name: string; size: number }) {
  return (
    <>
      <BrandMark brand={brand} size={size} />
      <span className={isWordmark(brand) ? "sr-only" : undefined}>{name}</span>
    </>
  );
}

/** A tool's mark beside its name; GitHub's drawn mark and the extension's own icon beside theirs. */
function ToolName({ tool }: { tool: Tool }) {
  if (tool.mark === "github") {
    return (
      <>
        <GitHubMark className="size-5 shrink-0 text-ink" />
        <span>{tool.name}</span>
      </>
    );
  }
  if (tool.mark === "invoice-capture") {
    return (
      <>
        {/* Vestiarion's own extension icon, a PNG from the extension's store listing. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/extension/invoice-capture-48.png" alt="" aria-hidden width={20} height={20} className="size-5 shrink-0 rounded-md" />
        <span>{tool.name}</span>
      </>
    );
  }
  return <Named brand={tool.mark} name={tool.name} size={tool.size ?? 22} />;
}

/** A small mono label: a card's kind, a flow's source, a row's term. */
const LABEL = "font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-3";

function FeaturedCard({ tool }: { tool: Featured }) {
  return (
    <article aria-labelledby={`integration-${tool.brand}`} className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h3 id={`integration-${tool.brand}`} className="flex items-center gap-2.5 text-lg font-semibold text-ink">
          <Named brand={tool.brand} name={tool.name} size={30} />
        </h3>
        <p className={LABEL}>{tool.reach}</p>
      </div>
      <dl className="mt-4 grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t border-line pt-4 text-sm leading-relaxed">
        <dt className={cn(LABEL, "pt-[0.1875rem]")}>Comes in</dt>
        <dd className="text-pretty text-ink">{tool.comesIn}</dd>
        <dt className={cn(LABEL, "pt-[0.1875rem]")}>Goes back</dt>
        <dd className="text-pretty text-ink">{tool.goesBack}</dd>
      </dl>
      {tool.status && (
        <Badge size="sm" dot className="mt-3 self-start font-medium">
          {tool.status}
        </Badge>
      )}
      <p className="mt-auto flex flex-wrap items-center gap-x-6 pt-3 text-sm">
        <Link href={tool.href} prefetch={landingPrefetch(tool.href)} className="inline-flex min-h-11 items-center gap-1 font-semibold text-agent underline-offset-4 hover:underline">
          Setup guide<span className="sr-only">{` for ${tool.name}`}</span>
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
        {tool.watch && (
          <Link
            href={tool.watch.href}
            prefetch={landingPrefetch(tool.watch.href)}
            className="inline-flex min-h-11 items-center gap-1.5 font-medium text-ink-2 underline-offset-4 hover:text-agent hover:underline"
          >
            <Play aria-hidden className="size-3.5" />
            Watch it<span className="sr-only">{`, ${tool.name}, ${tool.watch.duration}`}</span>
            <span aria-hidden className="font-mono text-xs text-ink-3">
              {tool.watch.duration}
            </span>
          </Link>
        )}
      </p>
    </article>
  );
}

function FlowMark({ mark }: { mark: (typeof XERO_FLOW)[number]["mark"] }) {
  if (mark === "rules") {
    return (
      <span aria-hidden className="grid size-6 place-items-center rounded-md bg-agent/10 text-agent">
        <ShieldCheck className="size-3.5" />
      </span>
    );
  }
  return <BrandMark brand={mark} size={mark === "xero" ? 24 : 22} />;
}

/** Xero's loop, step by step: what comes in, what checks it, where it is paid, and what goes back. */
function XeroFlow() {
  return (
    <section aria-labelledby="integrations-flow" className="mt-4 rounded-2xl border border-line bg-raised/40 p-5 sm:mt-5 sm:p-6">
      <div className="flex flex-col gap-x-6 gap-y-1.5 lg:flex-row lg:items-baseline lg:justify-between">
        <h3 id="integrations-flow" className="text-balance text-lg font-semibold tracking-tight text-ink sm:text-xl">
          From your existing tools to a controlled payment.
        </h3>
        <p className={LABEL}>With Xero · the supported workflow</p>
      </div>
      <ol className="mt-4 grid gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4 lg:gap-4">
        {XERO_FLOW.map((step, index) => (
          <li key={step.title} className="relative min-w-0 rounded-xl border border-line bg-surface p-3.5 sm:p-4">
            <span className="flex min-h-6 items-center gap-2">
              <span className="font-mono text-xs font-semibold text-ink-3">{index + 1}</span>
              <FlowMark mark={step.mark} />
              <span className="min-w-0 text-sm font-semibold text-ink">{step.title}</span>
            </span>
            <span className="mt-1.5 block text-pretty text-sm leading-relaxed text-ink-2">{step.body}</span>
            {/* The arrow between steps, where they sit in one row. */}
            {index < XERO_FLOW.length - 1 && (
              <ArrowRight aria-hidden className="absolute -right-[0.875rem] top-1/2 z-10 hidden size-4 -translate-y-1/2 text-ink-3 lg:block" />
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-pretty text-xs leading-relaxed text-ink-3">
        Payments in shadow mode and on Arc testnet are booked only into a Xero demo company.
      </p>
    </section>
  );
}

function MoreTools({ children }: { children: ReactNode }) {
  return (
    <div className="mt-10">
      <h3 id="integrations-more" className="text-base font-semibold text-ink">
        More of the tools your team already uses
      </h3>
      <p className="mt-1 max-w-2xl text-pretty text-sm leading-relaxed text-ink-2">
        The same checks apply whichever tool a bill comes from. Nothing a tool sends is a reason to pay by itself.
      </p>
      {children}
    </div>
  );
}

export function Integrations() {
  return (
    <Section id="integrations" tone="ground" aria-labelledby="integrations-title" className="scroll-mt-16 border-b border-line">
        {/* The heading and what it means for the business side by side on a wide screen, one above the other below it. */}
        <Reveal className="grid gap-x-12 gap-y-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end">
          <div>
            <Eyebrow className="text-agent">Integrations</Eyebrow>
            <Heading id="integrations-title" className="mt-3 max-w-4xl text-balance">
              Keep your tools. Vestiarion connects to them.
            </Heading>
          </div>
          <p className="max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2 sm:text-lg lg:pb-1">
            Your accounting, CRM and team tools stay in place. Bills, won deals and finished work come in from them, nothing is paid until it passes your rules,
            and the tools that support it get the outcome back.
          </p>
        </Reveal>

        <div className="mt-8 grid gap-4 sm:mt-10 md:grid-cols-2 md:gap-5">
          {FEATURED.map((tool) => (
            <FeaturedCard key={tool.name} tool={tool} />
          ))}
        </div>

        <XeroFlow />

        <MoreTools>
          {/*
            Below a tablet's width the tools are rows of one list, so a phone does not scroll through nine boxes; from it,
            three cards to a row, nine in three full rows.
          */}
          <ul
            aria-labelledby="integrations-more"
            className="mt-4 grid divide-y divide-line rounded-xl border border-line bg-surface md:grid-cols-3 md:gap-3 md:divide-y-0 md:rounded-none md:border-0 md:bg-transparent"
          >
            {MORE_TOOLS.map((tool) => (
              <li key={tool.name} className="min-w-0">
                <Link
                  href={tool.href}
                  prefetch={landingPrefetch(tool.href)}
                  className="group flex h-full flex-col px-4 py-3.5 transition-colors duration-150 ease-standard md:rounded-xl md:border md:border-line md:bg-surface md:p-4 md:hover:border-line-strong"
                >
                  <span className="flex min-h-7 items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2.5 text-[0.9375rem] font-semibold text-ink">
                      <ToolName tool={tool} />
                    </span>
                    <span className={cn(LABEL, "shrink-0 text-[0.625rem]")}>{tool.kind}</span>
                  </span>
                  <span className="mt-1.5 block text-pretty text-sm leading-relaxed text-ink-2">
                    {tool.body}
                    <span className="sr-only">{` ${tool.name} setup guide.`}</span>
                    <ArrowRight
                      aria-hidden
                      className="ml-1 inline size-3.5 align-[-2px] text-agent transition-transform duration-150 ease-standard group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </MoreTools>

        <div className="mt-10 border-t border-line pt-7">
          <div className="flex flex-col gap-x-8 gap-y-1 lg:flex-row lg:items-baseline lg:justify-between">
            <h3 id="integrations-foundations" className="text-base font-semibold text-ink">
              Built on Arc, with Circle
            </h3>
            <p className="text-pretty text-sm leading-relaxed text-ink-2">Not tools you connect: where every payment is made, and the wallets that send it.</p>
          </div>
          {/* One ruled panel, a row for each: who it is and its site, what the product does on it, and the evidence. */}
          <ul aria-labelledby="integrations-foundations" className="mt-4 divide-y divide-line rounded-xl border border-line bg-surface">
            {FOUNDATIONS.map((item) => (
              <li
                key={item.name}
                className="grid min-w-0 gap-x-8 gap-y-3 p-4 sm:p-5 md:grid-cols-[12rem_minmax(0,1fr)] lg:grid-cols-[13rem_minmax(0,1fr)_11rem]"
              >
                <div className="min-w-0">
                  <Eyebrow className="text-agent">{item.role}</Eyebrow>
                  <div className="mt-2 flex min-h-8 items-center justify-between gap-3 lg:justify-start">
                    <p className="flex items-center gap-2.5 text-lg font-semibold text-ink">
                      <Named brand={item.brand} name={item.name} size={28} />
                    </p>
                    <a
                      href={item.site.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-6 shrink-0 items-center font-mono text-xs text-ink-3 underline-offset-4 transition-colors duration-150 ease-standard hover:text-agent hover:underline"
                    >
                      {item.site.label} ↗<span className="sr-only">{`, ${item.name}'s own site (opens in a new tab)`}</span>
                    </a>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-pretty text-sm leading-relaxed text-ink-2">{item.body}</p>
                  <ul className="mt-2 grid gap-1.5">
                    {item.facts.map((fact) => (
                      <li key={fact} className="flex items-start gap-2 text-[0.8125rem] leading-snug text-ink-2">
                        <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-agent" strokeWidth={2.5} />
                        {fact}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="flex flex-wrap content-start gap-x-4 gap-y-1 font-mono text-xs md:col-start-2 lg:col-start-auto lg:flex-col">
                  {item.links.map((link) => {
                    const external = link.href.startsWith("https://");
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        prefetch={landingPrefetch(link.href)}
                        className="inline-flex min-h-6 items-center font-semibold text-agent underline-offset-4 hover:underline"
                        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                      >
                        {link.label} {external ? "↗" : "→"}
                        {external && <span className="sr-only"> (opens in a new tab)</span>}
                      </Link>
                    );
                  })}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-8 flex flex-col gap-x-10 gap-y-3 border-t border-line pt-5 lg:flex-row lg:items-center lg:justify-between">
          <Link
            href={ALL_INTEGRATIONS}
            prefetch={false}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 self-start whitespace-nowrap text-[0.9375rem] font-semibold text-agent underline-offset-4 hover:underline lg:self-auto"
          >
            Explore all integrations
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
          <p className="max-w-2xl text-xs leading-relaxed text-ink-3 lg:text-right">
            Intuit and QuickBooks are trademarks of Intuit Inc. Zoho, Zoho Books and Zoho CRM are trademarks of Zoho Corporation Pvt. Ltd. Arc, Circle, Slack,
            Telegram, Xero, HubSpot, Pipedrive, Asana, GitHub and Chrome are trademarks of their respective owners. Their names and marks show what Vestiarion
            is built on and connects to, not an endorsement.
          </p>
        </div>
    </Section>
  );
}
