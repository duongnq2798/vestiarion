/**
 * What Try it on past decisions says (docs/superpowers/specs/2026-10-10-policy-replay-design.md §2), in a module of its
 * own: the settings' client forms show it, and a server component (a guide's screenshot) can read it, which it cannot
 * read from a "use client" module.
 */
export const RULE_TRIAL_COPY = {
  button: "Try it on past decisions",
  apply: "Apply this figure",
  window: "Past decisions from",
  unchanged: "Unchanged",
  nowHeld: "Would now be held",
  nowPaid: "Would now be paid",
  nowTwoPeople: "Would now need two people",
  cantTell: "Can't tell",
  nothing: "No decision in this window would change.",
  none: "The agent made no decision on a bill or a milestone in this window.",
  note: "A replay of the code's checks on what each decision recorded, with the figure in force and with this one. It does not ask the model again, and it does not change the spending-limit contract on Arc, screening, the new payee check or who approves.",
} as const;
