import { linkLabel, linksIn, MAX_DELIVERABLES, type Deliverable, type DeliverableKind } from "../asana/deliverables";
import type { AttachmentFacts, CommentFacts } from "./map";
import { linksToIssue } from "./urls";

export { deliverablesFrom, fingerprintOf, MAX_DELIVERABLES, type Deliverable, type DeliverableKind } from "../asana/deliverables";

/**
 * What an issue delivers, as Vestiarion keeps and compares it (docs/superpowers/specs/2026-10-31-linear-acceptance-
 * design.md LN6, LN10): its attachments, the https links in its description, and those in its comments, uploads to
 * `uploads.linear.app` among them. Pure: no I/O. The shapes, the link reading and the fingerprint are Asana's
 * (`../asana/deliverables`), which name no tool.
 *
 * A Linear attachment is a link, its address fixed once made: a new file or a new pull request is a new attachment. So
 * an attachment counts in the fingerprint by its id and its address, never by its update time, which Linear moves each
 * time an integration refreshes what it shows (a pull request's checks, say) and which would take an acceptance back for
 * nothing. Renaming an attachment changes nothing; adding, removing or replacing an attachment or a link changes it.
 */
const ORDER: Record<DeliverableKind, number> = { attachment: 0, link: 1, comment_link: 2 };

/**
 * At most this many bytes of deliverables are kept on a link, with room to spare: migration 0147 refuses more than
 * 32,000 in Postgres's text of the list (`octet_length(deliverables::text)`), and the accepted copy is the same list. A
 * link may be 500 characters as written and several times that once its non-ASCII letters are encoded, and anyone in
 * the Linear workspace can post fifty in a comment, so the last ones are left out until the rest fits, and counted by
 * number, as deliverables past the first 50 are.
 */
export const DELIVERABLES_BYTES = 30_000;

/** The deliverables' size as Postgres writes jsonb out: their JSON in UTF-8, with a space after each `:` and `,`. */
export function storedBytes(items: readonly Deliverable[]): number {
  const separators = items.reduce((sum, item) => sum + 2 * Object.values(item).filter((value) => value !== undefined).length - 1, Math.max(0, items.length - 1));
  return new TextEncoder().encode(JSON.stringify(items)).length + separators;
}

export function deliverablesOf(input: { description: string; attachments: readonly AttachmentFacts[]; comments: readonly CommentFacts[]; identifier: string }): {
  deliverables: Deliverable[];
  more: number;
} {
  const all: Deliverable[] = [];
  const seen = new Set<string>();
  const add = (item: Deliverable) => {
    const key = `${item.kind === "attachment" ? "attachment" : "link"} ${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(item);
  };
  for (const attachment of input.attachments) {
    add({ kind: "attachment", id: attachment.id, label: attachment.title, href: attachment.href, version: attachment.href });
  }
  // Links to the issue itself are not deliverables.
  for (const href of linksIn(input.description)) if (!linksToIssue(href, input.identifier)) add({ kind: "link", id: href, label: linkLabel(href), href });
  for (const comment of input.comments) {
    for (const href of linksIn(comment.body)) if (!linksToIssue(href, input.identifier)) add({ kind: "comment_link", id: href, label: linkLabel(href), href });
  }
  all.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = all.slice(0, MAX_DELIVERABLES);
  while (kept.length > 0 && storedBytes(kept) > DELIVERABLES_BYTES) kept.pop();
  return { deliverables: kept, more: all.length - kept.length };
}
