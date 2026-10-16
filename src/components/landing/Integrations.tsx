import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { BrandMark, isWordmark, type Brand } from "@/components/vx/BrandMarks";
import { ARC_URL, CIRCLE_URL } from "@/lib/site-links";

const REPOSITORY = "https://github.com/duongnq2798/vestiarion";

/**
 * The tools Vestiarion connects to, grouped by the job each does for the business, then what it is built on
 * (docs/superpowers/specs/2026-10-16-landing-integrations-design.md; the marks themselves:
 * docs/superpowers/specs/2026-10-07-brand-marks-design.md, docs/superpowers/specs/2026-10-12-integration-marks-design.md).
 *
 * A group's summary says the workflow its tools share; a card says only what is particular to its tool: whether it
 * writes back, and what it leaves out. Every sentence was checked against the tool's guide and code, so a read-only
 * connector says so, a write-back says who allows it, and nothing says a tool approves or pays. Each card links to its
 * guide, which is how a visitor learns to connect it: there is no connect flow before sign-in. "Built on" and "works
 * with", never "partners" or "trusted by": none of these companies vouches for Vestiarion.
 */

interface Integration {
  brand: Brand;
  name: string;
  body: string;
  /** The tool's guide. */
  href: string;
  /** The mark's height, so marks of different shapes look the same size; 24 when not set. */
  mark?: number;
  /** What a visitor should know before counting on it, under what it does. */
  status?: string;
}

interface Group {
  id: string;
  title: string;
  summary: string;
  /** Three to a group, so every row of three is full. */
  tools: readonly [Integration, Integration, Integration];
}

export const INTEGRATION_GROUPS: readonly Group[] = [
  {
    id: "accounting",
    title: "Accounting",
    summary: "Open bills come in for review. None is paid until you add it and it passes every check.",
    tools: [
      { brand: "xero", name: "Xero", body: "Payments made on Arc are booked back to Xero once you approve each entry.", href: "/docs/guides/xero" },
      {
        brand: "quickbooks-lockup",
        name: "QuickBooks Online",
        body: "Bills with a balance left to pay in QuickBooks Online, refreshed by webhook. Read-only.",
        href: "/docs/guides/quickbooks",
        status: "Sandbox companies for now",
      },
      { brand: "zohobooks-lockup", name: "Zoho Books", body: "Open, overdue and partly paid bills; drafts stay out. Read-only.", href: "/docs/guides/zohobooks", mark: 26 },
    ],
  },
  {
    id: "sales",
    title: "Sales and CRM",
    summary: "Won deals come in, ready to plan as the payments each customer owes you. You confirm every plan.",
    tools: [
      { brand: "hubspot", name: "HubSpot", body: "Once you allow it, what each customer paid and still owes goes back on the deal.", href: "/docs/guides/hubspot" },
      {
        brand: "pipedrive-lockup",
        name: "Pipedrive",
        body: "Kept current by webhook. Receipts for payments on Arc mainnet can go back on the deal.",
        href: "/docs/guides/pipedrive",
        mark: 22,
      },
      { brand: "zohocrm-lockup", name: "Zoho CRM", body: "Won deals with their accounts and contacts. Read-only.", href: "/docs/guides/zohocrm", mark: 26 },
    ],
  },
  {
    id: "work",
    title: "Work and team chat",
    summary: "Pay for finished work once a person accepts it, and see each decision where your team talks.",
    tools: [
      { brand: "asana-lockup", name: "Asana", body: "A completed task is paid only after a person accepts it against its criteria.", href: "/docs/guides/asana", mark: 20 },
      { brand: "slack", name: "Slack", body: "The agent's decisions in a channel you pick. Ask what's waiting, or pause it.", href: "/docs/guides/slack" },
      { brand: "telegram", name: "Telegram", body: "Decisions in your own chat, and bills you send it to add. The bot never pays.", href: "/docs/guides/telegram" },
    ],
  },
];

/** What Vestiarion is built on, and where a developer starts: links to the evidence, Arc and Circle to their own sites too. */
const FOUNDATIONS: ReadonlyArray<{
  brand: Brand;
  name: string;
  role: string;
  body: string;
  link: { href: string; label: string };
  site?: { href: string; label: string };
}> = [
  {
    brand: "arc",
    name: "Arc",
    role: "Settles on",
    body: "Payments settle in USDC on Arc, and anyone can check each one.",
    link: { href: "/open", label: "See the payments" },
    site: { href: ARC_URL, label: "arc.io" },
  },
  {
    brand: "circle",
    name: "Circle",
    role: "Payments through",
    body: "Circle's wallets carry the live USDC payments.",
    link: { href: `${REPOSITORY}/blob/main/src/lib/circle/liveProvider.ts`, label: "Read the code" },
    site: { href: CIRCLE_URL, label: "circle.com" },
  },
  {
    brand: "npm",
    name: "npm",
    role: "SDK on",
    body: "@vestiarion/sdk, a typed client for every endpoint.",
    link: { href: "/docs/get-started/sdk", label: "SDK docs" },
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

/** What a card's link leads to: the tool's guide, which says what it does and how to connect it. */
function GuideLink({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm font-medium text-agent underline-offset-4 group-hover:underline", className)}>
      Setup guide
      <ArrowRight
        aria-hidden
        className="size-3.5 transition-transform duration-150 ease-standard group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
      />
    </span>
  );
}

/** A group's heading and summary, beside its tools from a laptop's width and above them below it. */
function GroupRow({ id, title, summary, children }: { id: string; title: string; summary: string; children: ReactNode }) {
  return (
    <div className="grid gap-4 border-b border-line py-6 sm:py-7 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10">
      <div className="min-w-0">
        <h3 id={`integrations-${id}`} className="text-base font-semibold text-ink">
          {title}
        </h3>
        <p className="mt-1 max-w-xl text-pretty text-sm leading-relaxed text-ink-2">{summary}</p>
      </div>
      {children}
    </div>
  );
}

export function Integrations() {
  return (
    <section id="integrations" aria-labelledby="integrations-title" className="scroll-mt-16 border-b border-line">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <Reveal className="max-w-3xl">
          <Eyebrow className="text-agent">Integrations</Eyebrow>
          <h2 id="integrations-title" className="mt-3 text-balance text-3xl font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-5xl">
            Keep your tools. Vestiarion connects to them.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2 sm:text-lg">
            Bills, won deals and finished work come in from the software you already use, so nobody retypes them. Nothing is paid until it passes
            your checks.
          </p>
        </Reveal>

        <div className="mt-8 border-t border-line sm:mt-10">
          {INTEGRATION_GROUPS.map((group) => (
            <GroupRow key={group.id} id={group.id} title={group.title} summary={group.summary}>
              {/*
                Below a tablet's width the three tools are rows of one list, the guide's link beside the mark, so a phone
                does not scroll through nine boxes; from it, three cards side by side, the link at the foot of each.
              */}
              <ul
                aria-labelledby={`integrations-${group.id}`}
                className="grid divide-y divide-line rounded-xl border border-line bg-surface md:grid-cols-3 md:gap-3 md:divide-y-0 md:rounded-none md:border-0 md:bg-transparent"
              >
                {group.tools.map((tool) => (
                  <li key={tool.name} className="min-w-0">
                    <Link
                      href={tool.href}
                      className="group flex h-full flex-col p-4 transition-colors duration-150 ease-standard md:rounded-xl md:border md:border-line md:bg-surface md:p-5 md:hover:border-line-strong"
                    >
                      <span className="flex min-h-8 items-center justify-between gap-3">
                        <span className="flex items-center gap-2.5 text-base font-semibold text-ink">
                          <Named brand={tool.brand} name={tool.name} size={tool.mark ?? 24} />
                        </span>
                        <GuideLink className="shrink-0 md:hidden" />
                      </span>
                      <span className="mt-2 block text-sm leading-relaxed text-ink-2 md:mt-3">{tool.body}</span>
                      {tool.status && (
                        <Badge size="sm" dot className="mt-2.5 self-start font-medium">
                          {tool.status}
                        </Badge>
                      )}
                      <GuideLink className="mt-auto hidden pt-3 md:inline-flex" />
                    </Link>
                  </li>
                ))}
              </ul>
            </GroupRow>
          ))}

          <GroupRow id="foundations" title="Under the hood" summary="Where payments settle, and where developers start.">
            <ul
              aria-labelledby="integrations-foundations"
              className="grid divide-y divide-line rounded-xl border border-line md:grid-cols-3 md:divide-x md:divide-y-0"
            >
              {FOUNDATIONS.map((item) => {
                const external = item.link.href.startsWith("https://");
                return (
                  <li key={item.name} className="min-w-0 px-4 py-4 sm:px-5">
                    <Eyebrow>{item.role}</Eyebrow>
                    <p className="mt-2 flex min-h-6 items-center gap-2 text-[0.9375rem] font-semibold text-ink">
                      <Named brand={item.brand} name={item.name} size={item.brand === "npm" ? 16 : 20} />
                    </p>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{item.body}</p>
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
                      <Link
                        href={item.link.href}
                        className="inline-flex min-h-6 items-center font-semibold text-agent underline-offset-4 hover:underline"
                        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                      >
                        {item.link.label} {external ? "↗" : "→"}
                        {external && <span className="sr-only"> (opens in a new tab)</span>}
                      </Link>
                      {item.site && (
                        <a
                          href={item.site.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-6 items-center text-ink-3 underline-offset-4 transition-colors duration-150 ease-standard hover:text-agent hover:underline"
                        >
                          {item.site.label} ↗<span className="sr-only">{`, ${item.name}'s own site (opens in a new tab)`}</span>
                        </a>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          </GroupRow>
        </div>

        <p className="pt-5 text-xs leading-relaxed text-ink-3">
          npm is a registered trademark of npm, Inc. Intuit and QuickBooks are trademarks of Intuit Inc. Zoho, Zoho Books and Zoho CRM are trademarks
          of Zoho Corporation Pvt. Ltd. Arc, Circle, Slack, Telegram, Xero, HubSpot, Pipedrive and Asana are trademarks of their respective owners.
          Their names and marks show what Vestiarion is built on and connects to, not an endorsement.
        </p>
      </div>
    </section>
  );
}
