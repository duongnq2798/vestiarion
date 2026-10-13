/**
 * The same work billed twice, once as a bill and once as a milestone (docs/superpowers/specs/2026-10-13-project-budgets-
 * design.md P9). A purchase order or a deliverable is one obligation: a contractor's milestone for it, and a bill naming
 * the same order or the same delivered work, would pay it twice. Two bills for one order are `findDuplicates`'s
 * (../agent/duplicates.ts); this is the pair across the two books, which nothing compared before.
 *
 * Whichever came second waits for a person, with the first named: the agent never pays it on its own. Paying both is a
 * person's decision, which Approve and pay, or Pay now, makes as for any hold. Pure and I/O-free.
 */

export const SAME_WORK_RULE = "obligation.duplicate_reference";

export interface WorkItem {
  kind: "bill" | "milestone";
  id: string;
  /** The vendor's or contractor's counterparty id. */
  counterpartyId: string;
  /** What the person reading it knows it by: the bill's memo, the milestone's title. */
  label: string;
  poReference: string | null;
  /**
   * Where the delivered work can be seen: a milestone's verification source, a bill's memo. Only web addresses in it
   * count (`deliverableKeys`).
   */
  evidence: string | null;
  status: string;
  createdAt: string;
}

export type SameWorkSignal = "purchase_order" | "deliverable";

export interface SameWorkMatch {
  otherKind: "bill" | "milestone";
  otherId: string;
  otherLabel: string;
  otherStatus: string;
  signal: SameWorkSignal;
  /** The purchase order or the address both name. */
  reference: string;
  /** Plain words, written to the ledger as they are. */
  explanation: string;
}

/** A bill rejected, or a milestone closed without paying, is no obligation any more. */
const ENDED: Record<WorkItem["kind"], ReadonlySet<string>> = {
  bill: new Set(["rejected"]),
  milestone: new Set(["closed"]),
};

/**
 * What people write in a purchase order field when there is none ("N/A", "none", "TBD", "0"), as `purchaseOrderKey`
 * reads it: no purchase order, so two of them never name the same order.
 */
const NO_PURCHASE_ORDER = new Set(["na", "none", "nil", "null", "nopo", "tbd", "tba", "tbc", "unknown", "notapplicable"]);

/** Purchase orders are written inconsistently: "PO-1042", "po 1042", "1042" (as `findDuplicates` reads them). */
export function purchaseOrderKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^po/, "");
  return compact.length === 0 || NO_PURCHASE_ORDER.has(compact) || /^0+$/.test(compact) ? null : compact;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/** Query parameters that only say where a link was shared from, never which work it is. */
const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|usp)$/i;

/**
 * The web addresses in a piece of text, each reduced to what names the work: no scheme, `www.` or trailing slash, no
 * tracking parameter, in lower case, and a GitHub pull request or issue cut after its number (`/files`, `/commits`, a
 * query or an anchor name the same pull request). Any other address keeps its query and its anchor, which often say
 * which document or record it is (`open?id=`, `watch?v=`, `#INV-2`): two addresses that differ there are two works.
 */
export function deliverableKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const keys = new Set<string>();
  for (const raw of text.match(URL_IN_TEXT) ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(raw.replace(/[.,;:]+$/, ""));
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let path = parsed.pathname.replace(/\/+$/, "");
    const github = host === "github.com" ? /^(\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+)/.exec(path) : null;
    if (github) path = github[1];
    if (host.length === 0 || path.length === 0) continue;
    let rest = "";
    if (!github) {
      const query = [...parsed.searchParams].filter(([name]) => !TRACKING_PARAM.test(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (query.length > 0) rest += `?${new URLSearchParams(query).toString()}`;
      if (parsed.hash.length > 1) rest += parsed.hash;
    }
    keys.add(`${host}${path}${rest}`.toLowerCase());
  }
  return [...keys];
}

function earlier(a: WorkItem, b: WorkItem): boolean {
  const left = Date.parse(a.createdAt);
  const right = Date.parse(b.createdAt);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left < right;
  return a.id < b.id;
}

const KIND_WORDS: Record<WorkItem["kind"], string> = { bill: "bill", milestone: "milestone" };

/**
 * The earlier bills or milestones of the other kind that `subject` repeats: the same counterparty and purchase order,
 * or the same delivered work. Only ones entered before it: of the pair, the first goes as usual and the second waits.
 */
export function sameWorkMatches(subject: WorkItem, others: readonly WorkItem[]): SameWorkMatch[] {
  const po = purchaseOrderKey(subject.poReference);
  const evidence = new Set(deliverableKeys(subject.evidence));
  const matches: SameWorkMatch[] = [];
  for (const other of others) {
    if (other.kind === subject.kind || other.id === subject.id) continue;
    if (ENDED[other.kind].has(other.status)) continue;
    if (!earlier(other, subject)) continue;
    const otherWords = `${KIND_WORDS[other.kind]} "${other.label}"`;
    const subjectWords = KIND_WORDS[subject.kind];
    if (po !== null && other.counterpartyId === subject.counterpartyId && purchaseOrderKey(other.poReference) === po) {
      matches.push({
        otherKind: other.kind,
        otherId: other.id,
        otherLabel: other.label,
        otherStatus: other.status,
        signal: "purchase_order",
        reference: subject.poReference ?? po,
        explanation: `This ${subjectWords} names purchase order ${subject.poReference}, as the ${otherWords} for the same payee does (${other.status}): paying both would pay that order twice.`,
      });
      continue;
    }
    const shared = deliverableKeys(other.evidence).find((key) => evidence.has(key));
    if (shared) {
      matches.push({
        otherKind: other.kind,
        otherId: other.id,
        otherLabel: other.label,
        otherStatus: other.status,
        signal: "deliverable",
        reference: shared,
        explanation: `This ${subjectWords} points at the same delivered work, ${shared}, as the ${otherWords} (${other.status}): paying both would pay that work twice.`,
      });
    }
  }
  return matches;
}
