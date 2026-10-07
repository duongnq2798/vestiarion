import Link from "next/link";
import { BrandMark, isWordmark, type Brand } from "@/components/vx/BrandMarks";

const REPOSITORY = "https://github.com/duongnq2798/vestiarion";

/**
 * What Vestiarion is built on and works with, each with a link to the evidence
 * rather than a bare logo (docs/superpowers/specs/2026-10-07-brand-marks-design.md):
 * the services the code integrates with, in one quiet ink, each named in words.
 * "Built on" and "works with", never "partners" or "trusted by": none of them
 * vouches for Vestiarion.
 */
const SERVICES: ReadonlyArray<{ brand: Brand; name: string; role: string; body: string; href: string; check: string }> = [
  { brand: "arc", name: "Arc", role: "Built on", body: "Payments settle on Arc, and each of ours links to its explorer.", href: "/open", check: "See the payments" },
  {
    brand: "circle",
    name: "Circle",
    role: "Payments through",
    body: "Circle's wallets carry the live USDC payment path.",
    href: `${REPOSITORY}/blob/main/src/lib/circle/liveProvider.ts`,
    check: "Read the code",
  },
  { brand: "slack", name: "Slack", role: "Works with", body: "The agent's decisions in a channel your team picks.", href: "/docs/guides/slack", check: "Read the guide" },
  { brand: "telegram", name: "Telegram", role: "Works with", body: "The agent's decisions in your own chat. The bot never pays.", href: "/docs/guides/telegram", check: "Read the guide" },
  { brand: "npm", name: "npm", role: "SDK on", body: "@vestiarion/sdk, a typed client for every endpoint.", href: "/docs/get-started/sdk", check: "Read the docs" },
];

export function BuiltWith() {
  return (
    <section aria-labelledby="built-with-title" className="border-b border-line bg-surface/80">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 id="built-with-title" className="border-b border-line py-3 font-mono text-xs uppercase tracking-[0.1em] text-ink-3">
          Built on, and works with
        </h2>
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {SERVICES.map((service) => {
            const external = service.href.startsWith("https://");
            return (
              <li key={service.name} className="min-w-0 border-line py-4 pr-4 lg:border-l lg:pl-5 lg:first:border-l-0 lg:first:pl-0">
                <Link href={service.href} className="group block" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
                  <p className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-3">{service.role}</p>
                  <p className="mt-2 flex h-5 items-center gap-2 text-[0.9375rem] font-semibold text-ink">
                    <BrandMark brand={service.brand} className="h-4 w-auto text-ink-2 transition-colors duration-150 ease-standard group-hover:text-ink" />
                    <span className={isWordmark(service.brand) ? "sr-only" : undefined}>{service.name}</span>
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{service.body}</p>
                  <span className="mt-2 inline-block font-mono text-xs font-semibold text-agent group-hover:underline">
                    {service.check} {external ? "↗" : "→"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
