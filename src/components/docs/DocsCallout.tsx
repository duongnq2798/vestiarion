import { Banknote, CircleAlert, Info, Lightbulb, TriangleAlert, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout, type CalloutProps } from "@/components/ui/Callout";
import { cn } from "@/components/ui/cn";
import { CALLOUT_LABELS, type CalloutKind } from "@/lib/docs/callouts";
import { isPageHref } from "@/lib/docs/paths";

/**
 * How each kind of callout is drawn (docs redesign D6): a tint and rule of its own, an icon, and the colour of its
 * label; its label is `CALLOUT_LABELS`, written beside the title, so the kind never rests on colour alone. A note is the
 * agent's blue at its lightest, a tip proof green, a warning held amber, and real money refused red.
 */
const CALLOUT_STYLE = {
  note: { box: "border-agent-line/60 bg-agent-soft/40", accent: "text-agent", icon: Info },
  tip: { box: "border-proof-line/70 bg-proof-soft/50", accent: "text-proof", icon: Lightbulb },
  important: { box: "border-agent-line bg-agent-soft/70", accent: "text-agent", icon: CircleAlert },
  warning: { box: "border-held-line bg-held-soft/60", accent: "text-held", icon: TriangleAlert },
  "real-money": { box: "border-refused-line bg-refused-soft/60", accent: "text-refused", icon: Banknote },
} as const satisfies Record<CalloutKind, { box: string; accent: string; icon: LucideIcon }>;

/**
 * The MDX `<Callout>`: `kind` sets its tint, icon and label; a callout with no kind is drawn as before, in the tone it
 * names (neutral by default).
 */
export function DocsCallout({ kind, title, tone, className, children }: { kind?: CalloutKind; title?: ReactNode; tone?: CalloutProps["tone"]; className?: string; children?: ReactNode }) {
  const body = "text-[0.9375rem] leading-relaxed [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p]:text-[0.9375rem] [&_p]:leading-relaxed";
  if (!kind) {
    return (
      <Callout tone={tone} title={title} className={cn("my-6", body, className)}>
        {children}
      </Callout>
    );
  }
  const { box, accent, icon: Icon } = CALLOUT_STYLE[kind];
  return (
    <div role="note" className={cn("my-7 flex gap-3 rounded-xl border px-4 py-3.5 sm:px-5", box, className)}>
      <Icon aria-hidden className={cn("mt-0.5 size-[1.125rem] shrink-0", accent)} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.9375rem] font-semibold leading-snug text-ink">
          <span className={cn("text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", accent)}>{CALLOUT_LABELS[kind]}</span>
          {title}
        </p>
        {children && <div className={cn("mt-1.5 text-ink-2", body)}>{children}</div>}
      </div>
    </div>
  );
}

/**
 * A guide's next step in the app (docs clarity C4): one button-styled link, used sparingly, where reading has led to
 * something to do. A page of this site opens in the same tab.
 */
export function Action({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <div className="my-6">
      <Button asChild size="lg">
        {isPageHref(href) || href.startsWith("/") ? <Link href={href}>{children}</Link> : <a href={href}>{children}</a>}
      </Button>
    </div>
  );
}
