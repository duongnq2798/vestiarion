import { EVIDENCE_MEANINGS, EVIDENCE_WORDS, SIGNED_ENTRY_PROVES, type EvidenceChain, type EvidenceKind, type EvidenceLink, type EvidenceStepId } from "./evidence-chain";
import { networkProfile, type Network } from "./network";
import type { EntryCheck } from "./receipts/verify";

/**
 * One payment's evidence as a file (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E7): the chain as the
 * page shows it, each fact with its label in words, and every entry it rests on in full, with the fields the audit
 * export carries, so each can be checked alone with the workspace's public keys. Pure: the route reads and gates.
 */

export const EVIDENCE_FORMAT = "vestiarion-evidence/1";

export interface EvidenceKey {
  id: string;
  status: "active" | "retired";
  publicKeyPem: string;
}

/** How to check an entry alone, as the receipt page says it. */
export const CHECK_AN_ENTRY = [
  "body_hash = sha256(canonical JSON of { actor, domain, action, summary, detail }, keys sorted)",
  "signature = Ed25519 over the 32 bytes of body_hash, by the key signing_key_id names",
  "hash = sha256(prev_hash || body_hash || signature), the hex strings joined",
] as const;

/**
 * A cited entry in full, snake_case, with the server's check: every evidence file carries these (the evidence chain's,
 * the payee lock's, a receipt's and the close pack's), so one verifier reads them all (evidence API EA10, EA13).
 */
export interface SignedEntry {
  seq: number;
  id: string | null;
  ts: string;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  body_hash: string;
  signature: string;
  prev_hash: string;
  hash: string;
  signing_key_id: string | null;
  check: EntryCheck | null;
}

export interface EvidenceDocumentFact {
  /** The label in words. */
  label: string;
  kind: EvidenceKind;
  text: string;
  /** Who stated it: a member's email in a download, their user id through the API (evidence API EA3); null when the ledger names no one. */
  who: string | null;
  at: string | null;
  fill?: string;
  notes?: string[];
  link?: EvidenceLink;
  warn?: true;
  /** The signed entries it rests on, by seq. */
  entries: number[];
}

export interface EvidenceDocumentStep {
  id: EvidenceStepId;
  title: string;
  /** The label in words. */
  label: string;
  kind: EvidenceKind;
  caveat?: string;
  facts: EvidenceDocumentFact[];
}

/** The file Download evidence gives, and `GET /api/v1/invoices/{id}/evidence` answers (evidence API EA2, EA10). */
export interface EvidenceDocument {
  format: typeof EVIDENCE_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  subject: EvidenceChain["subject"];
  /** The seven words, what each means, and how many facts each holds. */
  labels: Record<string, { words: string; meaning: string; facts: number }>;
  steps: EvidenceDocumentStep[];
  signedEntryProves: string;
  checkAnEntry: string[];
  keys: EvidenceKey[];
  entries: SignedEntry[];
}

export function evidenceDocument(input: {
  chain: EvidenceChain;
  workspace: { slug: string; name: string };
  keys: EvidenceKey[];
  now: Date;
}): EvidenceDocument {
  const { chain } = input;
  const label = (kind: EvidenceKind) => EVIDENCE_WORDS[kind];
  return {
    format: EVIDENCE_FORMAT,
    exportedAt: input.now.toISOString(),
    workspace: input.workspace,
    network: { id: chain.network, label: networkProfile(chain.network).label },
    subject: chain.subject,
    /** The seven words, what each means, and how many facts each holds. */
    labels: Object.fromEntries(
      Object.entries(EVIDENCE_WORDS).map(([kind, words]) => [kind, { words, meaning: EVIDENCE_MEANINGS[kind as EvidenceKind], facts: chain.tally[kind as EvidenceKind] }])
    ),
    steps: chain.steps.map((step) => ({
      id: step.id,
      title: step.title,
      label: label(step.kind),
      kind: step.kind,
      ...(step.caveat ? { caveat: step.caveat } : {}),
      facts: step.facts.map((fact) => ({
        label: label(fact.kind),
        kind: fact.kind,
        text: fact.text,
        who: fact.who ?? null,
        at: fact.at ?? null,
        ...(fact.fill ? { fill: fact.fill } : {}),
        ...(fact.notes && fact.notes.length > 0 ? { notes: fact.notes } : {}),
        ...(fact.link ? { link: fact.link } : {}),
        ...(fact.warn ? { warn: true as const } : {}),
        entries: fact.seqs,
      })),
    })),
    signedEntryProves: SIGNED_ENTRY_PROVES,
    checkAnEntry: [...CHECK_AN_ENTRY],
    keys: input.keys,
    entries: chain.entries.map((entry) => ({
      seq: entry.seq,
      id: entry.id ?? null,
      ts: entry.ts,
      actor: entry.actor,
      domain: entry.domain,
      action: entry.action,
      summary: entry.summary,
      detail: entry.detail,
      body_hash: entry.body_hash,
      signature: entry.signature,
      prev_hash: entry.prev_hash,
      hash: entry.hash,
      signing_key_id: entry.signing_key_id,
      check: entry.check,
    })),
  };
}

/** `vestiarion-evidence-northstar-invoice-5f1e2d3c.json`: the workspace, the kind, and the record's id's first part. */
export function evidenceFileName(slug: string, kind: string, id: string): string {
  const safe = (value: string) => value.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "record";
  return `vestiarion-evidence-${safe(slug)}-${safe(kind)}-${safe(id.slice(0, 8))}.json`;
}
