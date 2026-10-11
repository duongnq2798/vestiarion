/**
 * The kinds of callout the docs use (docs clarity C2), each with the label written beside its title on the page and at
 * the head of its quote in the Markdown view, so a callout's kind never rests on colour alone.
 */
export const CALLOUT_LABELS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  "real-money": "Real money",
} as const;

export type CalloutKind = keyof typeof CALLOUT_LABELS;

/** The kind's label, for a callout that names one; undefined for an unknown or absent kind. */
export function calloutLabel(kind: unknown): string | undefined {
  return typeof kind === "string" && Object.hasOwn(CALLOUT_LABELS, kind) ? CALLOUT_LABELS[kind as CalloutKind] : undefined;
}
