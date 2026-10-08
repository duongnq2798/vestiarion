import Link from "next/link";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { BuildTabs } from "./build/BuildTabs";

const WAYS_IN = [
  { href: "/docs/api", label: "API reference" },
  { href: "/docs/ai-integration/mcp", label: "MCP server" },
  { href: "/docs/guides/github", label: "GitHub app" },
] as const;

/**
 * Where a developer comes in (docs/superpowers/specs/2026-10-08-landing-motion-design.md M3): the REST API, the typed
 * SDK, the MCP server and the GitHub app, each as the snippet its guide gives, typed into a terminal.
 */
export function BuildOnIt() {
  return (
    <section id="build" aria-labelledby="build-title" className="scroll-mt-16 border-t border-line bg-surface/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-center lg:gap-14">
        <Reveal>
          <Eyebrow className="text-xs">Build on it</Eyebrow>
          <h2 id="build-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">
            Runs where you already work.
          </h2>
          <p className="mt-4 max-w-md text-[0.9375rem] leading-relaxed text-ink-2">
            Send bills from your own system, ask your AI assistant what the agent held and why, or pay for a pull request from a comment. A record that comes in this way is decided like one typed into the console, with every guardrail.
          </p>
          <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
            {WAYS_IN.map((way) => (
              <li key={way.href}>
                <Link href={way.href} className="font-mono text-xs font-semibold text-agent underline-offset-4 hover:underline">
                  {way.label} →
                </Link>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={80} className="min-w-0">
          <BuildTabs />
        </Reveal>
      </div>
    </section>
  );
}
