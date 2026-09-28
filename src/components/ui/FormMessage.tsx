import { CircleAlert, CircleCheck, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "success" | "error";

const TONE: Record<Tone, { icon: LucideIcon; className: string }> = {
  neutral: { icon: Info, className: "text-ink-2" },
  success: { icon: CircleCheck, className: "text-proof" },
  error: { icon: CircleAlert, className: "text-refused" },
};

/**
 * Where a form says how its last submission went. The live region is in the
 * page from the start — empty until there is something to say — so a screen
 * reader announces each new message.
 */
export function FormMessage({ tone = "neutral", children, className }: { tone?: Tone; children?: ReactNode; className?: string }) {
  const { icon: Icon, className: toneClass } = TONE[tone];
  return (
    <p role="status" aria-live="polite" className={cn("flex min-h-5 items-start gap-1.5 text-sm", toneClass, className)}>
      {children ? (
        <>
          <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{children}</span>
        </>
      ) : null}
    </p>
  );
}
