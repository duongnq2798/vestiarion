/**
 * Which work tool's card a milestone shows on Contractors (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR6, JR22; docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN4, LN16; Asana acceptance A16): Asana's
 * task card, Linear's issue card, Jira's issue card, or several. Pure and browser-safe.
 *
 * - A card for a task or an issue linked to the milestone always shows, as its history once the milestone is paid.
 * - One work tool verifies a milestone: an open milestone linked in one tool offers no card for linking it in another.
 *   Each tool's link refuses a milestone linked in another (Jira acceptance JR6); the page offers no card that would.
 * - An open milestone linked in none offers a tool's card where that tool is connected, or where no other one is: a
 *   workspace that works in one tool is not asked on every milestone to connect the others.
 * - The criteria are the milestone's, whichever tool it is linked in: where several cards offer to link it, the first
 *   that asks for them does (Asana's, connected, then Linear's), and the cards after it leave them to it
 *   (`linearCriteria`, `jiraCriteria` false), so they are asked once.
 *
 * A tool not configured on the deployment (null, or no `jira` at all) shows nothing, and leaves the others' cards
 * exactly as they were without it.
 */
export interface WorkToolFacts {
  connected: boolean;
  /** The milestone is linked to one of this tool's tasks or issues. */
  linked: boolean;
}

export interface WorkToolCards {
  asana: boolean;
  linear: boolean;
  jira: boolean;
  /** Linear's card asks for the criteria itself. */
  linearCriteria: boolean;
  /** Jira's card asks for the criteria itself. */
  jiraCriteria: boolean;
}

type Tool = "asana" | "linear" | "jira";

export function workToolCards(input: { pending: boolean; asana: WorkToolFacts | null; linear: WorkToolFacts | null; jira?: WorkToolFacts | null }): WorkToolCards {
  const tools: Record<Tool, WorkToolFacts | null> = { asana: input.asana, linear: input.linear, jira: input.jira ?? null };
  const offers = (name: Tool) => {
    const tool = tools[name];
    if (tool === null) return false;
    const others = (Object.keys(tools) as Tool[]).flatMap((other) => (other !== name && tools[other] !== null ? [tools[other] as WorkToolFacts] : []));
    return tool.linked || (input.pending && others.every((other) => !other.linked) && (tool.connected || others.every((other) => !other.connected)));
  };
  const asana = offers("asana");
  const linear = offers("linear");
  const jira = offers("jira");
  // Asana's card asks for the criteria while it offers to link a task, once Asana is connected.
  const asanaAsks = asana && input.asana !== null && !input.asana.linked && input.asana.connected;
  const linearCriteria = linear && !asanaAsks;
  return { asana, linear, jira, linearCriteria, jiraCriteria: jira && !asanaAsks && !linearCriteria };
}
