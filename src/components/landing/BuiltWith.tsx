import Link from "next/link";
import { BrandMark, isWordmark, type Brand } from "@/components/vx/BrandMarks";
import { ARC_URL, CIRCLE_URL } from "@/lib/site-links";

const REPOSITORY = "https://github.com/duongnq2798/vestiarion";

/**
 * What Vestiarion is built on and works with, each with a link to the evidence
 * rather than a bare logo (docs/superpowers/specs/2026-10-07-brand-marks-design.md,
 * docs/superpowers/specs/2026-10-12-integration-marks-design.md): the services
 * the code integrates with, each in its own mark and named in words. "Built on"
 * and "works with", never "partners" or "trusted by": none of them vouches for
 * Vestiarion. Arc and Circle also link to their own sites, beside the evidence,
 * in a new tab. QuickBooks Online shows Intuit's QuickBooks lockup, which spells
 * QuickBooks, so its body names QuickBooks Online in full. Pipedrive shows its
 * wordmark, Asana its logo, the dots and "asana", and Zoho Books its logo, the
 * book and "Zoho Books", each in the name's place.
 */
const SERVICES: ReadonlyArray<{
  /** The service's mark, beside its name, or in its place when the mark spells it. */
  brand: Brand;
  name: string;
  role: string;
  body: string;
  href: string;
  check: string;
  site?: { href: string; label: string };
  /** A lockup whose words are small beside its symbol: drawn taller, into the row's margins, so the row keeps its height. */
  lockup?: true;
}> = [
  { brand: "arc", name: "Arc", role: "Built on", body: "Payments settle on Arc, and each of ours links to its explorer.", href: "/open", check: "See the payments", site: { href: ARC_URL, label: "arc.io" } },
  {
    brand: "circle",
    name: "Circle",
    role: "Payments through",
    body: "Circle's wallets carry the live USDC payment path.",
    href: `${REPOSITORY}/blob/main/src/lib/circle/liveProvider.ts`,
    check: "Read the code",
    site: { href: CIRCLE_URL, label: "circle.com" },
  },
  { brand: "xero", name: "Xero", role: "Works with", body: "Bills come in for review; payments on Arc are booked back once approved.", href: "/docs/guides/xero", check: "Read the guide" },
  {
    brand: "quickbooks-lockup",
    lockup: true,
    name: "QuickBooks Online",
    role: "Works with",
    body: "Open bills from QuickBooks Online come in for review, sooner via webhooks.",
    href: "/docs/guides/quickbooks",
    check: "Read the guide",
  },
  {
    brand: "zohobooks-lockup",
    name: "Zoho Books",
    role: "Works with",
    body: "Open bills from Zoho Books come in for review, read from the Zoho data center the account lives in.",
    href: "/docs/guides/zohobooks",
    check: "Read the guide",
  },
  { brand: "hubspot", name: "HubSpot", role: "Works with", body: "Won deals come in with their customers, to plan as collection schedules; what each collected goes back to the deal.", href: "/docs/guides/hubspot", check: "Read the guide" },
  {
    brand: "pipedrive-lockup",
    name: "Pipedrive",
    role: "Works with",
    body: "Won deals come in with their organizations, to plan as collection schedules; what each collected on Arc mainnet goes back to the deal.",
    href: "/docs/guides/pipedrive",
    check: "Read the guide",
  },
  { brand: "asana-lockup", name: "Asana", role: "Works with", body: "Contractor work completed in a task is paid once a person accepts it against its criteria.", href: "/docs/guides/asana", check: "Read the guide" },
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
        {/*
          Eleven services: five to a row from a laptop's width, and two to a row below it. The eleventh, npm, is alone on
          its row at both widths, so it spans the whole row (last:col-span-full) and every row is full.
        */}
        <ul className="grid grid-cols-2 lg:grid-cols-5">
          {SERVICES.map((service) => {
            const external = service.href.startsWith("https://");
            return (
              <li
                key={service.name}
                className="min-w-0 border-line py-4 pr-4 last:col-span-full lg:border-l lg:pl-5 lg:nth-[5n+1]:border-l-0 lg:nth-[5n+1]:pl-0 lg:nth-[n+6]:border-t"
              >
                <Link href={service.href} className="group block" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
                  <p className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-3">{service.role}</p>
                  <p className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-[0.9375rem] leading-5 font-semibold text-ink">
                    <BrandMark brand={service.brand} size={service.lockup ? 23 : undefined} className={service.lockup ? "-mt-1.5 -mb-0.5" : undefined} />
                    <span className={isWordmark(service.brand) ? "sr-only" : undefined}>{service.name}</span>
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{service.body}</p>
                  <span className="mt-2 inline-block font-mono text-xs font-semibold text-agent group-hover:underline">
                    {service.check} {external ? "↗" : "→"}
                  </span>
                </Link>
                {service.site && (
                  <a
                    href={service.site.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block font-mono text-xs text-ink-3 underline-offset-4 transition-colors duration-150 ease-standard hover:text-agent hover:underline"
                  >
                    {service.site.label} ↗<span className="sr-only">{`, ${service.name}'s own site (opens in a new tab)`}</span>
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        <p className="border-t border-line py-3 text-[0.6875rem] leading-relaxed text-ink-3">
          npm is a registered trademark of npm, Inc. Intuit and QuickBooks are trademarks of Intuit Inc. Zoho and Zoho Books are trademarks of
          Zoho Corporation Pvt. Ltd. Arc, Circle, Slack, Telegram, Xero, HubSpot, Pipedrive and Asana are trademarks of their respective owners.
          Their names and marks show what Vestiarion is built on and connects to, not an endorsement.
        </p>
      </div>
    </section>
  );
}
