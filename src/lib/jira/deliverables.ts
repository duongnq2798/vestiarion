import { linkLabel, linksIn, MAX_DELIVERABLES, type Deliverable, type DeliverableKind } from "../asana/deliverables";
import { httpsLink } from "../asana/map";
import { DELIVERABLES_BYTES, storedBytes } from "../linear/deliverables";
import type { AttachmentFacts, CommentFacts, RemoteLinkFacts } from "./map";
import { linksToIssue } from "./urls";

export { deliverablesFrom, fingerprintOf, MAX_DELIVERABLES, type Deliverable, type DeliverableKind } from "../asana/deliverables";
export { DELIVERABLES_BYTES, storedBytes } from "../linear/deliverables";

/**
 * What an issue delivers, as Vestiarion keeps and compares it (docs/superpowers/specs/2026-11-09-jira-acceptance-
 * design.md JR8, JR13): its files, its web links, the links in its description, and those in its newest 50 comments.
 * Pure: no I/O. The shapes, the link reading and the fingerprint are Asana's (`../asana/deliverables`), the size kept is
 * Linear's (`../linear/deliverables`); none of them names a tool.
 *
 * A file counts in the fingerprint by its id and the time it was added, as Asana's do: a new version of a file is a new
 * attachment in Jira. A web link counts by its id and its address. Renaming a file or a web link changes nothing; adding,
 * removing or replacing a file, a web link or a link in the text changes it.
 */
const ORDER: Record<DeliverableKind, number> = { attachment: 0, link: 1, comment_link: 2 };

/** The ADF walk's bounds: Jira's documents nest a few levels, and a comment holds a few hundred nodes. */
export const ADF_DEPTH = 50;
export const ADF_NODES = 20_000;

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const CARDS = new Set(["inlineCard", "blockCard", "embedCard"]);

/**
 * The https links in a description or a comment as Jira stores it, Atlassian Document Format: the target of each link
 * mark, the address of each smart link (`inlineCard`, `blockCard`, `embedCard`), and the bare links in text without a
 * link mark. Linked text is read for its target alone, so the place a person opens is the one kept and compared, never
 * the words shown for it. The walk stops at 50 levels or 20,000 nodes, whatever the document holds past them.
 */
export function adfLinksIn(doc: unknown): string[] {
  const found: string[] = [];
  const add = (value: unknown) => {
    const href = httpsLink(value);
    if (href && !found.includes(href)) found.push(href);
  };
  const stack: Array<{ node: unknown; depth: number }> = [{ node: doc, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < ADF_NODES) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    visited += 1;
    const item = record(node);
    if (!item) continue;
    const type = typeof item.type === "string" ? item.type : "";
    if (CARDS.has(type)) add(record(item.attrs)?.url);
    const marks = Array.isArray(item.marks) ? item.marks.slice(0, 20) : [];
    const linked = marks.map(record).filter((mark) => mark?.type === "link");
    for (const mark of linked) add(record(mark?.attrs)?.href);
    if (type === "text" && linked.length === 0 && typeof item.text === "string") for (const href of linksIn(item.text.slice(0, 20_000))) add(href);
    if (depth < ADF_DEPTH && Array.isArray(item.content)) {
      // Pushed last first, so the document is read in its own order.
      for (let index = item.content.length - 1; index >= 0; index -= 1) stack.push({ node: item.content[index], depth: depth + 1 });
    }
  }
  return found;
}

export function deliverablesOf(input: {
  descriptionLinks: readonly string[];
  attachments: readonly AttachmentFacts[];
  remoteLinks: readonly RemoteLinkFacts[];
  comments: readonly CommentFacts[];
  key: string;
  siteUrl: string;
}): { deliverables: Deliverable[]; more: number } {
  const all: Deliverable[] = [];
  const seen = new Set<string>();
  const add = (item: Deliverable) => {
    const key = `${item.kind === "attachment" ? "attachment" : "link"}|${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(item);
  };
  const self = (href: string) => linksToIssue(href, input.key, input.siteUrl);
  for (const file of input.attachments) add({ kind: "attachment", id: `file:${file.id}`, label: file.filename, href: file.href, version: file.createdAt });
  for (const web of input.remoteLinks) if (!self(web.href)) add({ kind: "attachment", id: `remotelink:${web.id}`, label: web.title, href: web.href, version: web.href });
  // Links to the issue itself are not deliverables.
  for (const href of input.descriptionLinks) if (!self(href)) add({ kind: "link", id: href, label: linkLabel(href), href });
  for (const comment of input.comments) for (const href of comment.links) if (!self(href)) add({ kind: "comment_link", id: href, label: linkLabel(href), href });
  all.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = all.slice(0, MAX_DELIVERABLES);
  while (kept.length > 0 && storedBytes(kept) > DELIVERABLES_BYTES) kept.pop();
  return { deliverables: kept, more: all.length - kept.length };
}
