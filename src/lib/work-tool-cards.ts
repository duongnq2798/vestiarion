/**
 * Which work tool's card a milestone shows on Contractors (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md
 * LN4, LN16; Asana acceptance A16): Asana's task card, Linear's issue card, or both. Pure and browser-safe.
 *
 * - A card for a task or an issue linked to the milestone always shows, as its history once the milestone is paid.
 * - One work tool verifies a milestone: an open milestone linked in one tool offers no card for linking it in the other.
 *   Linear refuses to link a milestone linked to Asana; Asana's link was left as it was, so its card is not offered on a
 *   milestone linked to Linear.
 * - An open milestone linked in neither offers a tool's card where that tool is connected, or where the other one is
 *   not: a workspace that works in one tool is not asked on every milestone to connect the other.
 * - The criteria are the milestone's, whichever tool it is linked in: where both cards offer to link it and Asana's,
 *   connected, asks for them, Linear's leaves them to it (`linearCriteria` false), so they are asked once.
 *
 * A tool not configured on the deployment (null) shows nothing, and leaves the other's card exactly as it was without it.
 */
export interface WorkToolFacts {
  connected: boolean;
  /** The milestone is linked to one of this tool's tasks or issues. */
  linked: boolean;
}

export function workToolCards(input: { pending: boolean; asana: WorkToolFacts | null; linear: WorkToolFacts | null }): { asana: boolean; linear: boolean; linearCriteria: boolean } {
  const offers = (tool: WorkToolFacts | null, other: WorkToolFacts | null) =>
    tool !== null && (tool.linked || (input.pending && !(other?.linked ?? false) && (tool.connected || !(other?.connected ?? false))));
  const asana = offers(input.asana, input.linear);
  const linear = offers(input.linear, input.asana);
  // Asana's card asks for the criteria while it offers to link a task, once Asana is connected.
  const asanaAsks = asana && input.asana !== null && !input.asana.linked && input.asana.connected;
  return { asana, linear, linearCriteria: linear && !asanaAsks };
}
