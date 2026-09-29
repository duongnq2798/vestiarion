import type { MDXComponents } from "mdx/types";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { DocsHeading, textOf } from "@/components/docs/DocsHeading";
import { EndpointTable } from "@/components/docs/EndpointTable";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { slugify } from "@/lib/docs/headings";

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
  if (href.startsWith("/") && !href.startsWith("/api/") && !/\.(?:md|txt|json)(?:[?#]|$)/.test(href)) {
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

/** A card that is one link: a title and a line on what is behind it. */
function DocsCard({ title, href, children }: { title: string; href: string; children?: ReactNode }) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-3 text-[0.9375rem] font-semibold tracking-tight text-ink">
        {title}
        <ArrowRight aria-hidden className="size-4 shrink-0 text-ink-3" />
      </span>
      <span className="mt-1.5 block text-sm leading-relaxed text-ink-2 [&>p]:m-0">{children}</span>
    </>
  );
  return (
    <Card asChild interactive className="block p-5">
      {href.startsWith("/docs/") || href === "/docs" ? <Link href={href}>{body}</Link> : <a href={href}>{body}</a>}
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
  p: ({ children }) => <p className="my-4 leading-7 text-ink-2 [overflow-wrap:anywhere]">{children}</p>,
  a: Anchor,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  ul: ({ children }) => <ul className="my-4 list-disc space-y-2 pl-6 leading-7 text-ink-2 marker:text-ink-3">{children}</ul>,
  ol: ({ children }) => <ol className="my-4 list-decimal space-y-2 pl-6 leading-7 text-ink-2 marker:text-ink-3">{children}</ol>,
  li: ({ children }) => <li className="pl-1 [overflow-wrap:anywhere] [&>p]:my-2">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-6 border-l-2 border-line-strong pl-4 text-ink-2 [&>p]:my-2">{children}</blockquote>,
  hr: () => <hr className="my-10 border-line" />,
  code: ({ children }) => (
    <code className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 font-mono text-[0.8125em] text-ink [overflow-wrap:anywhere]">{children}</code>
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
  Cards,
  Card: DocsCard,
  Callout: (props: ComponentProps<typeof Callout>) => <Callout {...props} className={cn("my-6 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0", props.className)} />,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
