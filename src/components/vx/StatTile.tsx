import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";

/** One figure with its label: a card, and a lifting one when it links to the page behind the number. */
export function StatTile({
  label,
  children,
  sub,
  tone = "default",
  href,
}: {
  label: string;
  children: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "held";
  href?: string;
}) {
  const content = (
    <>
      <Eyebrow className={tone === "held" ? "text-held" : undefined}>{label}</Eyebrow>
      <div className="mt-2 min-w-0 text-[1.375rem] font-semibold leading-none tracking-tight text-ink sm:text-[1.625rem]">{children}</div>
      {sub && <div className="mt-2 text-[0.8125rem] leading-snug text-ink-2">{sub}</div>}
    </>
  );
  const className = cn("block min-w-0 px-4 py-4", tone === "held" && "bg-held-soft");
  return href ? (
    <Card asChild interactive tone={tone} className={className}>
      <Link href={href}>{content}</Link>
    </Card>
  ) : (
    <Card tone={tone} className={className}>
      {content}
    </Card>
  );
}
