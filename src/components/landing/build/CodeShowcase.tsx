"use client";

import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/CopyButton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { highlight, type TokenKind } from "./highlight";
import { SNIPPETS, type Snippet } from "./snippets";

/** Each token's colour on the panel's dark ground, every one at least 4.5:1 against it. */
const TOKEN: Record<TokenKind, string> = {
  plain: "text-ground/90",
  punctuation: "text-ground/70",
  comment: "text-ground/60",
  string: "text-proof-line",
  keyword: "text-agent-line",
  command: "text-held-line",
  flag: "text-agent-line",
  variable: "text-refused-line",
  property: "text-agent-line",
  number: "text-held-line",
};

/** A snippet's lines, highlighted once, when this module loads: the snippets never change. */
const LINES = new Map(SNIPPETS.map((snippet) => [snippet.id, highlight(snippet.code, snippet.lang)]));

function Code({ snippet }: { snippet: Snippet }) {
  return (
    // A long line scrolls inside the panel, never the page; the panel takes focus so a keyboard can scroll it. Every
    // panel is as tall as the longest snippet, so switching tabs never moves what is below.
    <pre
      tabIndex={0}
      aria-label={`${snippet.tab} example`}
      className="min-h-[19rem] overflow-x-auto px-4 py-4 font-mono text-[0.78rem] leading-[1.7] outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-agent-line sm:px-5"
    >
      <code>
        {LINES.get(snippet.id)!.map((line, index) => (
          <span key={index} className="block whitespace-pre">
            {line.length === 0
              ? " "
              : line.map((token, at) => (
                  <span key={at} className={TOKEN[token.kind]}>
                    {token.text}
                  </span>
                ))}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * The ways a developer builds on Vestiarion, one tab each (docs/superpowers/specs/2026-10-18-landing-developers-design.md):
 * the snippet its guide gives, highlighted, with a button that copies exactly that, what to know about it, and where it
 * goes further. Static: nothing is fetched or typed out, and reduced motion changes nothing but the tab marker's glide.
 */
export function CodeShowcase() {
  return (
    <div className="overflow-hidden rounded-2xl border border-ink/10 bg-ink text-ground shadow-raised">
      <Tabs defaultValue={SNIPPETS[0].id} className="gap-0">
        <div className="border-b border-ground/10 px-3 py-2.5 sm:px-4">
          <TabsList aria-label="Ways to build on Vestiarion" className="w-full border-ground/10 bg-ground/[0.06] sm:w-fit">
            {SNIPPETS.map((snippet) => (
              <TabsTrigger key={snippet.id} value={snippet.id} className="min-w-16 text-ground/75 hover:text-ground data-[state=active]:text-ink">
                {snippet.tab}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {SNIPPETS.map((snippet) => (
          <TabsContent key={snippet.id} value={snippet.id} className="min-w-0">
            <div className="flex min-h-11 items-center justify-between gap-3 border-b border-ground/10 pl-4 pr-2 sm:pl-5">
              <p className="min-w-0 truncate font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-ground/65">{snippet.context}</p>
              <CopyButton
                value={snippet.code}
                label={`Copy the ${snippet.tab} example`}
                aria-label={`Copy the ${snippet.tab} example`}
                className="shrink-0 text-ground/75 hover:bg-ground/10 hover:text-ground active:bg-ground/15"
              >
                Copy
              </CopyButton>
            </div>
            <Code snippet={snippet} />
            <div className="min-h-[6.5rem] border-t border-ground/10 px-4 py-3.5 sm:px-5">
              <p className="text-pretty text-[0.8125rem] leading-relaxed text-ground/75">{snippet.note}</p>
              <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                {snippet.links.map((link) => {
                  const external = link.href.startsWith("https://");
                  const Icon = external ? ArrowUpRight : ArrowRight;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={cn(
                        "inline-flex min-h-8 items-center gap-1 font-mono text-xs font-semibold text-agent-line underline-offset-4 hover:underline",
                      )}
                      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                    >
                      {link.label}
                      <Icon aria-hidden className="size-3.5" />
                      {external && <span className="sr-only"> (opens in a new tab)</span>}
                    </Link>
                  );
                })}
              </p>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
