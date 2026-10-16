import type { MDXComponents } from "mdx/types";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CirclePlay,
  Code2,
  GitBranch,
  KeyRound,
  Landmark,
  Layers,
  Package,
  Receipt,
  Route,
  ScanText,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { Action, DocsCallout } from "@/components/docs/DocsCallout";
import { DocsHeading, textOf } from "@/components/docs/DocsHeading";
import { EndpointTable } from "@/components/docs/EndpointTable";
import { Flow, FlowStep } from "@/components/docs/Flow";
import { McpToolTable } from "@/components/docs/McpToolTable";
import { Screenshot } from "@/components/docs/Screenshot";
import { TopicIndex } from "@/components/docs/TopicIndex";
import { Video } from "@/components/docs/Video";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { slugify } from "@/lib/docs/headings";
import { isPageHref } from "@/lib/docs/paths";

/**
 * How the docs' MDX renders: the product's type and primitives instead of
 * bare HTML. Headings here take the id of their own text; the docs page
 * replaces `h2` and `h3` with `headingComponents(headings)`, which also
 * numbers repeated headings the way the table of contents does.
 */

/** A fenced block arrives as `<pre><code className="language-x">source</code></pre>`. */
function Pre({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const lang = /(?:^|\s)language-(\S+)/.exec(code?.props.className ?? "")?.[1];
  const source = textOf(code ? code.props.children : children).replace(/\n$/, "");
  return <CodeBlock code={source} lang={lang} />;
}

function Anchor({ href = "", className, children, ...props }: ComponentProps<"a">) {
  const classes = cn("font-medium text-agent underline [overflow-wrap:anywhere] decoration-agent-line underline-offset-4 transition-colors duration-150 ease-standard hover:decoration-agent", className);
  // A page is a client-side navigation; a document (a `.md` view, llms.txt, the OpenAPI JSON) is a plain link.
  if (isPageHref(href)) {
    return (
      <Link href={href} className={classes} {...props}>
        {children}
      </Link>
    );
  }
  const external = /^https?:\/\//.test(href);
  return (
    <a href={href} className={classes} {...(external ? { rel: "noreferrer" } : {})} {...props}>
      {children}
    </a>
  );
}

/** A grid of `Card`s: one column on a phone, two from `sm`. */
function Cards({ children }: { children?: ReactNode }) {
  return <div className="my-6 grid gap-3 sm:grid-cols-2">{children}</div>;
}

/**
 * The icons a card may carry (docs redesign D5), by name, so the MDX stays plain and every card draws from one set of
 * line icons. A name outside the set is a build error, not a missing icon.
 */
const CARD_ICONS: Record<string, LucideIcon> = {
  decision: Sparkles,
  shadow: Layers,
  payment: Send,
  bank: Landmark,
  capture: ScanText,
  accounting: BookOpen,
  bills: Receipt,
  controls: ShieldCheck,
  api: Code2,
  webhooks: Webhook,
  sdk: Package,
  cli: Terminal,
  key: KeyRound,
  ai: Bot,
  github: GitBranch,
  video: CirclePlay,
  flow: Route,
};

/** A card that is one link: an optional icon, a title and a line on what is behind it. */
function DocsCard({ title, href, icon, children }: { title: string; href: string; icon?: string; children?: ReactNode }) {
  const Icon = icon === undefined ? undefined : CARD_ICONS[icon];
  if (icon !== undefined && !Icon) throw new Error(`<Card icon="${icon}"> is not one of ${Object.keys(CARD_ICONS).join(", ")}`);
  const body = (
    <>
      <div className="flex items-center gap-3 text-[0.9375rem] font-semibold tracking-tight text-ink">
        {Icon && (
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg border border-agent-line/60 bg-agent-soft/60 text-agent">
            <Icon className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">{title}</span>
        <ArrowRight
          aria-hidden
          className="size-4 shrink-0 text-ink-3 transition-transform duration-150 ease-standard group-hover:translate-x-0.5 group-hover:text-agent motion-reduce:transition-none"
        />
      </div>
      {/* MDX gives a card's body as a paragraph; the card sets its type. */}
      <div className="mt-2 text-sm leading-relaxed text-ink-2 [&>p]:m-0 [&>p]:text-sm [&>p]:leading-relaxed">{children}</div>
    </>
  );
  return (
    <Card asChild interactive className="group block p-5">
      {isPageHref(href) ? <Link href={href}>{body}</Link> : <a href={href}>{body}</a>}
    </Card>
  );
}

const components: MDXComponents = {
  h2: ({ children }) => (
    <DocsHeading depth={2} id={slugify(textOf(children))}>
      {children}
    </DocsHeading>
  ),
  h3: ({ children }) => (
    <DocsHeading depth={3} id={slugify(textOf(children))}>
      {children}
    </DocsHeading>
  ),
  p: ({ children }) => <p className="my-4 text-[1rem] leading-[1.75] text-ink-2 [overflow-wrap:anywhere]">{children}</p>,
  a: Anchor,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  ul: ({ children }) => <ul className="my-4 list-disc space-y-2 pl-6 text-[1rem] leading-[1.75] text-ink-2 marker:text-ink-3">{children}</ul>,
  ol: ({ children }) => <ol className="my-4 list-decimal space-y-2 pl-6 text-[1rem] leading-[1.75] text-ink-2 marker:font-mono marker:text-sm marker:text-ink-3">{children}</ol>,
  li: ({ children }) => <li className="pl-1 [overflow-wrap:anywhere] [&>p]:my-2">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-6 border-l-2 border-line-strong pl-4 text-ink-2 [&>p]:my-2">{children}</blockquote>,
  hr: () => <hr className="my-10 border-line" />,
  code: ({ children }) => (
    <code className="rounded-md border border-line bg-ground/70 px-1.5 py-0.5 font-mono text-[0.8125em] text-ink [overflow-wrap:anywhere]">{children}</code>
  ),
  pre: Pre,
  table: ({ children }) => (
    <Table containerClassName="my-6 rounded-xl border border-line bg-surface">
      {children}
    </Table>
  ),
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell className="align-top text-ink-2">{children}</TableCell>,
  EndpointTable,
  McpToolTable,
  Cards,
  Card: DocsCard,
  Screenshot,
  Video,
  Callout: DocsCallout,
  Action,
  Flow,
  FlowStep,
  TopicIndex,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
