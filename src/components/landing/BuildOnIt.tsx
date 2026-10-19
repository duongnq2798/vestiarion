import { ArrowUpRight, Braces, ScrollText, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { Reveal } from "@/components/ui/Reveal";
import { GitHubMark } from "@/components/vx/SiteChrome";
import { GITHUB_URL } from "@/lib/site-links";
import { CodeShowcase } from "./build/CodeShowcase";

/** Where a developer starts: the quickstart, from no key to reading a workspace's ledger. */
export const DEVELOPER_DOCS = "/docs/get-started/quickstart";

/**
 * What a developer gets, each as the docs and code say it: the operations a key reaches, the controls that still hold
 * (a key reads, or reads and writes; "The API never approves or pays"), and the ledger every write is signed into.
 */
export const BENEFITS: ReadonlyArray<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Braces,
    title: "Build on the API",
    body: "Read invoices, the treasury and the ledger, or add bills, counterparties and milestones, with a workspace API key.",
  },
  {
    icon: ShieldCheck,
    title: "Controls still apply",
    body: "What a key adds gets every check one typed into the console gets. No key, SDK call or MCP tool approves or pays.",
  },
  {
    icon: ScrollText,
    title: "Every action on record",
    body: "Each write is signed into the ledger with the key that made it, and the chain can be verified from code.",
  },
];

/** The other ways in, for a developer who needs one of them, in a line rather than a tab of its own. */
const ALSO = [
  { href: "/docs/webhooks", label: "Webhooks" },
  { href: "/docs/get-started/cli", label: "CLI" },
  { href: "/docs/guides/github", label: "GitHub app" },
] as const;

/**
 * For developers (docs/superpowers/specs/2026-10-18-landing-developers-design.md, after 2026-10-08-landing-motion-design.md
 * M3): for builders, where the integrations above are for business teams. What a developer can build, the controls
 * that hold whatever comes in this way, where to start, and beside it the real snippets for the API, the SDK and MCP.
 */
export function BuildOnIt() {
  return (
    <Section id="build" tone="surface" aria-labelledby="build-title" className="scroll-mt-16 border-b border-line" containerClassName="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center lg:gap-14">
        <Reveal>
          <Eyebrow className="text-agent">For developers</Eyebrow>
          <Heading id="build-title" className="mt-3 max-w-4xl text-balance">
            Runs where you already work.
          </Heading>
          <p className="mt-4 max-w-md text-pretty text-lede text-ink-2 md:max-w-2xl lg:max-w-md">
            For builders: connect your own applications through the REST API, the TypeScript SDK or the MCP server, with the same payment controls as the
            console.
          </p>
          <ul className="mt-6 grid max-w-md gap-4 md:max-w-none md:grid-cols-3 md:gap-5 lg:max-w-md lg:grid-cols-1 lg:gap-4">
            {BENEFITS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface text-agent">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">{title}</span>
                  <span className="mt-0.5 block text-pretty text-sm leading-relaxed text-ink-2">{body}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button asChild size="md">
              <Link href={DEVELOPER_DOCS} prefetch={false}>
                Read developer docs
                <ArrowUpRight aria-hidden />
              </Link>
            </Button>
            <Button asChild size="md" variant="secondary">
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                <GitHubMark className="size-4" />
                View on GitHub
                <ArrowUpRight aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            Also:{" "}
            {ALSO.map((item, index) => (
              <span key={item.href}>
                <Link
                  href={item.href}
                  prefetch={false}
                  className="font-medium text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-agent hover:decoration-agent"
                >
                  {item.label}
                </Link>
                {index < ALSO.length - 1 ? ", " : "."}
              </span>
            ))}
          </p>
        </Reveal>
        <Reveal delay={80} className="min-w-0">
          <CodeShowcase />
        </Reveal>
    </Section>
  );
}
