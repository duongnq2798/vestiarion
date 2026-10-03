import type { ApiErrorCode } from "@/lib/api/contract";
import { slugify, slugifyHeadings, type Heading } from "./headings";

/**
 * The sections of a generated API reference page, `/docs/api/<id>`. The page
 * has no MDX of its own, so its headings are this fixed list, in this order,
 * followed by the headings of its notes when `content/docs/api/<id>.mdx`
 * exists. The page, its table of contents and the link checker all read the
 * ids from here.
 */

export const REFERENCE_SECTIONS = {
  parameters: "Parameters",
  body: "Request body",
  tryIt: "Try it",
  samples: "Code samples",
  response: "Response",
  errors: "Errors",
  notes: "Notes",
} as const;

export type ReferenceSection = keyof typeof REFERENCE_SECTIONS;

/** What a reference page's fixed sections depend on: whether its operation takes a request body. */
export interface ReferenceShape {
  body?: boolean;
}

/**
 * The sections a reference page has, in page order: a write's request body
 * follows its parameters (write API R8), and "Notes" follows only when there
 * are notes. A section joins this list when the page renders it.
 */
function fixedSections(body: boolean): ReferenceSection[] {
  return body ? ["parameters", "body", "tryIt", "samples", "response", "errors"] : ["parameters", "tryIt", "samples", "response", "errors"];
}

/** A section's anchor. The fixed sections come first and are distinct, so each keeps its plain slug. */
export function sectionId(section: ReferenceSection): string {
  return slugify(REFERENCE_SECTIONS[section]);
}

/**
 * The page's `##` and `###` headings: the fixed sections, then "Notes" and
 * the notes' own headings when `notes` (the notes file's MDX) is given. They
 * are numbered as one page, so a notes heading that repeats a section title
 * gets `-2` rather than a second id the page already uses.
 */
export function referenceHeadings(notes: string | null, { body = false }: ReferenceShape = {}): Heading[] {
  const sections = notes === null ? fixedSections(body) : [...fixedSections(body), "notes" as const];
  const outline = sections.map((section) => `## ${REFERENCE_SECTIONS[section]}`).join("\n\n");
  return slugifyHeadings(notes === null ? outline : `${outline}\n\n${notes}`);
}

/**
 * The headings that come from the notes file: everything after "Notes". The
 * fixed sections come first and "Notes" is the last of them, so the first
 * heading with its id is that section: a notes heading named the same is
 * numbered `notes-2`.
 */
export function notesHeadings(headings: Heading[]): Heading[] {
  const notes = headings.findIndex((heading) => heading.id === sectionId("notes"));
  return notes < 0 ? [] : headings.slice(notes + 1);
}

/** Every anchor on the page, for the link checker. */
export function referenceSectionIds(notes: string | null, shape: ReferenceShape = {}): string[] {
  return referenceHeadings(notes, shape).map((heading) => heading.id);
}

/**
 * When each error code is returned, for the errors table on every reference
 * page, and for the table on the Errors page (`content/docs/get-started/errors.mdx`,
 * which the content test holds to this wording). The statuses are `STATUS_FOR`
 * in `@/lib/api/contract`.
 */
export const ERROR_MEANINGS: Record<ApiErrorCode, string> = {
  invalid_request: "An invalid `limit` or `cursor`, a filter value outside its allowed values, or a request body that does not validate. The message names the parameter or the field, and lists the accepted values.",
  unauthorized: "No key, or a malformed, unknown or revoked one: \"A valid API key is required.\"",
  forbidden: "The key's scopes do not cover this route: \"This key cannot do that.\"",
  not_found: "The requested resource does not exist in the key's workspace.",
  conflict: "The `Idempotency-Key` was already used for a different request, or the first request with it is still being handled.",
  rate_limited: "Too many requests; wait as long as `Retry-After` says before trying again.",
  unavailable: "A service the request depends on is unavailable.",
  internal: "An unexpected server error. Implementation details are not exposed.",
};
