import { Banknote, Info, Lightbulb, TriangleAlert, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout, type CalloutProps } from "@/components/ui/Callout";
import { cn } from "@/components/ui/cn";
import { CALLOUT_LABELS, type CalloutKind } from "@/lib/docs/callouts";
import { isPageHref } from "@/lib/docs/paths";

/** How each kind of callout is drawn: its tone and icon; its label is `CALLOUT_LABELS`. */
const CALLOUT_STYLE = {
  note: { tone: "neutral", icon: Info },
  tip: { tone: "proof", icon: Lightbulb },
  important: { tone: "agent", icon: Info },
  warning: { tone: "held", icon: TriangleAlert },
  "real-money": { tone: "refused", icon: Banknote },
} as const satisfies Record<CalloutKind, { tone: NonNullable<CalloutProps["tone"]>; icon: LucideIcon }>;

/**
 * The MDX `<Callout>`: `kind` sets its tone, icon and label; a callout with no kind is drawn as before, in the tone it
 * names (neutral by default).
 */
export function DocsCallout({ kind, title, tone, className, children }: { kind?: CalloutKind; title?: ReactNode; tone?: CalloutProps["tone"]; className?: string; children?: ReactNode }) {
  const style = kind ? { ...CALLOUT_STYLE[kind], label: CALLOUT_LABELS[kind] } : undefined;
  const Icon = style?.icon;
  const heading = style ? (
    <>
      <span className="mr-2 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em]">{style.label}</span>
      {title}
    </>
  ) : (
    title
  );
  return (
    <Callout
      tone={style?.tone ?? tone}
      icon={Icon ? <Icon /> : undefined}
      title={heading}
      className={cn("my-6 text-[0.9375rem] [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0", className)}
    >
      {children}
    </Callout>
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
