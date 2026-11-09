import type { ReactNode } from "react";
import { visibleText } from "@/lib/visible-text";

/**
 * Text someone outside the workspace wrote, as a page shows it (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL12): a counterparty's name, a lookalike's name, a milestone's title, an invoice's number or memo, a request's note, a
 * draft's fields. Only what shows is kept, at most `max` characters (`visibleText`), and it is set apart in `<bdi>`, so a
 * name written right to left cannot turn the words around it. `empty` stands in when nothing visible is left.
 */
export function UntrustedText({ text, max = 200, empty = null, className }: { text: string | null | undefined; max?: number; empty?: ReactNode; className?: string }) {
  const shown = visibleText(text, max);
  if (!shown && empty === null) return null;
  return <bdi className={className}>{shown || empty}</bdi>;
}
