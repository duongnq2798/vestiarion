import crypto from "node:crypto";
import type { AttachmentFacts, CommentFacts } from "./map";
import { httpsLink } from "./map";

/**
 * What a task delivers, as Vestiarion keeps and compares it (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md
 * A6, A10): the links in its description, its attachments, and the links in its comments. Pure: no I/O.
 *
 * The fingerprint is the SHA-256 of the set, in one order whatever order Asana answered in: each attachment by its id
 * and upload time (a new version is a new attachment in Asana), and each link by its address. Renaming an attachment
 * changes nothing; adding, removing or replacing a file or a link changes it. A person accepts one fingerprint; a
 * different one after acceptance is a deliverable that changed.
 */

export type DeliverableKind = "attachment" | "link" | "comment_link";

export interface Deliverable {
  kind: DeliverableKind;
  /** An attachment's gid, or a link's address. */
  id: string;
  label: string;
  /** Where a person opens it; null for an attachment with no https link. */
  href: string | null;
  /** An attachment's upload time: a new version is a new upload. */
  version?: string | null;
}

/** At most this many deliverables are kept and compared; more is said, and counted in the fingerprint. */
export const MAX_DELIVERABLES = 50;

const URL_IN_TEXT = /https:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?)\]}]+$/;

/** The https links in a text, each once, in the order they appear, without the punctuation a sentence leaves after one. */
export function linksIn(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(URL_IN_TEXT)) {
    const href = httpsLink(match[0].replace(TRAILING, ""));
    if (href && !found.includes(href)) found.push(href);
  }
  return found;
}

/** A link's label: its host and the start of its path. */
export function linkLabel(href: string): string {
  const url = new URL(href);
  const path = url.pathname === "/" ? "" : url.pathname.length > 40 ? `${url.pathname.slice(0, 39)}…` : url.pathname;
  return `${url.hostname.replace(/^www\./, "")}${path}`;
}

/** Links to the task itself, or to Asana's own pages for it, are not deliverables. */
function isTaskPage(href: string, taskUrl: string | null): boolean {
  if (taskUrl && href.replace(/\/f$/, "") === taskUrl.replace(/\/f$/, "")) return true;
  return false;
}

const ORDER: Record<DeliverableKind, number> = { attachment: 0, link: 1, comment_link: 2 };

export function deliverablesOf(input: { notes: string; attachments: readonly AttachmentFacts[]; comments: readonly CommentFacts[]; taskUrl: string | null }): {
  deliverables: Deliverable[];
  more: number;
} {
  const all: Deliverable[] = [];
  const seen = new Set<string>();
  const add = (item: Deliverable) => {
    const key = `${item.kind === "attachment" ? "attachment" : "link"}\u0000${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(item);
  };
  for (const attachment of input.attachments) {
    add({ kind: "attachment", id: attachment.gid, label: attachment.name, href: attachment.href, version: attachment.createdAt });
  }
  for (const href of linksIn(input.notes)) if (!isTaskPage(href, input.taskUrl)) add({ kind: "link", id: href, label: linkLabel(href), href });
  for (const comment of input.comments) {
    for (const href of linksIn(comment.text)) if (!isTaskPage(href, input.taskUrl)) add({ kind: "comment_link", id: href, label: linkLabel(href), href });
  }
  all.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { deliverables: all.slice(0, MAX_DELIVERABLES), more: Math.max(0, all.length - MAX_DELIVERABLES) };
}

/** The fingerprint of a set of deliverables: what a person accepts, and what a later read is compared with. */
export function fingerprintOf(deliverables: readonly Deliverable[], more = 0): string {
  const canonical = deliverables
    .map((item) => [item.kind === "attachment" ? "attachment" : "link", item.id, item.kind === "attachment" ? (item.version ?? "") : ""])
    .sort((a, b) => (a.join("\u0000") < b.join("\u0000") ? -1 : 1));
  return crypto.createHash("sha256").update(JSON.stringify({ v: 1, items: canonical, more }), "utf8").digest("hex");
}

/** The deliverables a row keeps, read back: anything that does not read is left out. */
export function deliverablesFrom(value: unknown): Deliverable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): Deliverable[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const { kind, id, label, href, version } = raw as Record<string, unknown>;
    if ((kind !== "attachment" && kind !== "link" && kind !== "comment_link") || typeof id !== "string" || typeof label !== "string") return [];
    return [{ kind, id, label, href: typeof href === "string" ? httpsLink(href) : null, ...(kind === "attachment" ? { version: typeof version === "string" ? version : null } : {}) }];
  });
}
