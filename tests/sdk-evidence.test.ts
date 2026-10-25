import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { verifyEntry, type PublicLedgerRow } from "@/lib/receipts/verify";
import { EVIDENCE_FORMATS, verifyEvidence, type EvidenceVerification } from "../sdk/src/index";

/**
 * The SDK's offline check of an evidence document (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA13): every committed example verifies with the keys it carries, each entry's verdict is the server's, and each kind
 * of tampering is named.
 */

vi.mock("server-only", () => ({}));

interface Entry extends PublicLedgerRow {
  id: string | null;
  ts: string;
  check: unknown;
}
interface Doc {
  format: string;
  keys: Array<{ id: string; status: string; publicKeyPem: string }>;
  entries: Entry[];
  [field: string]: unknown;
}

const EXAMPLES = ["get-invoice-evidence", "get-milestone-evidence", "get-invoice-receipt", "get-payee-lock-evidence", "get-close-pack"] as const;
const example = (id: string): Doc => (JSON.parse(readFileSync(`content/docs/examples/${id}.json`, "utf8")) as { data: Doc }).data;
const keysOf = (doc: Doc) => Object.fromEntries(doc.keys.map((key) => [key.id, key.publicKeyPem]));
const NOTE = "Checked with the keys the document carries. Compare their ids with the workspace's Audit log to tie them to the workspace.";

/** A key of its own, and entries signed with it exactly as src/lib/ledger.ts signs them, snake_case as a document carries them. */
function signer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = ledgerKeyId(privateKey);
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const sign = (seq: number, prevHash: string): Entry => {
    const body = { actor: "human" as const, domain: "ap" as const, action: "approval_given", summary: `Approved payment ${seq}`, detail: { seq } };
    const bodyHash = bodyHashOf(body);
    const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
    const hash = crypto.createHash("sha256").update(prevHash + bodyHash + signature).digest("hex");
    return { seq, id: null, ts: "2026-10-03T10:00:00.000Z", ...body, body_hash: bodyHash, signature, prev_hash: prevHash, hash, signing_key_id: keyId, check: null };
  };
  return { keyId, pem, sign };
}

/** An evidence document of entries signed here, each cited by one fact. */
function evidenceOf(entries: Entry[], key: { keyId: string; pem: string }): Doc {
  return {
    format: "vestiarion-evidence/1",
    steps: [{ id: "decided", facts: [{ entries: entries.map((entry) => entry.seq) }] }],
    keys: [{ id: key.keyId, status: "active", publicKeyPem: key.pem }],
    entries,
  };
}

const problemsOf = (result: EvidenceVerification) => result.problems.filter((problem) => problem !== NOTE);

describe.each(EXAMPLES)("the example %s", (id) => {
  it("verifies with the keys it carries, and says whose keys those are first (evidence API EA13)", async () => {
    const doc = example(id);
    const result = await verifyEvidence(doc);
    expect(result).toMatchObject({ ok: true, format: doc.format, keys: "document", problems: [NOTE] });
    expect(result.entries.map((entry) => entry.seq)).toEqual(doc.entries.map((entry) => entry.seq));
    // Every entry it carries is one a fact cites, so a missed citation field shows here as a lower count.
    expect(result.counts).toEqual({ cited: doc.entries.length, carried: doc.entries.length, verified: doc.entries.length, failed: 0, unchecked: 0 });
  });

  it("verifies with those keys given, as a map of key id to PEM or as the one PEM the Audit log shows", async () => {
    const doc = example(id);
    expect(await verifyEvidence(doc, { keys: keysOf(doc) })).toMatchObject({ ok: true, keys: "given", problems: [] });
    expect(await verifyEvidence(doc, { keys: doc.keys[0].publicKeyPem })).toMatchObject({ ok: true, keys: "given", problems: [] });
  });

  it("checks each entry as the server's verifyEntry does, and as the check the document carries", async () => {
    const doc = example(id);
    const keys = keysOf(doc);
    const result = await verifyEvidence(doc, { keys });
    for (const entry of doc.entries) {
      const check = result.entries.find((checked) => checked.seq === entry.seq)?.check;
      expect(check, `entry ${entry.seq}`).toEqual(await verifyEntry(entry, keys));
      expect(check, `entry ${entry.seq}`).toEqual(entry.check);
    }
  });

  it("never reads the document's own check fields", async () => {
    const doc = structuredClone(example(id));
    for (const entry of doc.entries) entry.check = { ok: false, reason: "Said so by the file." };
    expect((await verifyEvidence(doc)).ok).toBe(true);
  });

  it("verifies a download from the workspace, members by email, as it verifies the API's answer", async () => {
    const api = example(id);
    const session = asSessionDownload(api);
    if (id !== "get-invoice-receipt") expect(JSON.stringify(session)).toContain("@northstar.example");
    expect(await verifyEvidence(session)).toEqual(await verifyEvidence(api));
  });
});

/**
 * The same document as the workspace's page downloads it: members named by email (EA3). Only what the server writes
 * around the entries changes; the signed entries and the keys are the same.
 */
function asSessionDownload(doc: Doc): Doc {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.kind === "member" && typeof record.userId === "string") ids.add(record.userId);
      if (typeof record.who === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.who)) ids.add(record.who);
      Object.values(record).forEach(collect);
    }
  };
  const emailOf = (userId: string) => `member-${userId.slice(-2)}@northstar.example`;
  const named = (value: unknown, field?: string): unknown => {
    if (typeof value === "string") return field === "userId" ? value : [...ids].reduce((text, userId) => text.replaceAll(userId, emailOf(userId)), value);
    if (Array.isArray(value)) return value.map((item) => named(item));
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const out = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, named(item, key)]));
      if (record.kind === "member" && typeof record.userId === "string") out.email = emailOf(record.userId);
      return out;
    }
    return value;
  };
  const { entries, keys, ...around } = doc;
  collect(around);
  return { ...(named(around) as Omit<Doc, "entries" | "keys">), keys, entries } as Doc;
}

describe("verifyEvidence finds what was changed (evidence API EA13)", () => {
  it("an entry whose summary was changed", async () => {
    const doc = structuredClone(example("get-invoice-evidence"));
    const changed = doc.entries[2];
    changed.summary = `${changed.summary} (changed)`;
    for (const result of [await verifyEvidence(doc), await verifyEvidence(doc, { keys: keysOf(doc) })]) {
      expect(result.ok).toBe(false);
      expect(problemsOf(result)).toEqual([`Entry #${changed.seq} does not verify: The entry's content does not match its body hash.`]);
      expect(result.counts).toMatchObject({ verified: doc.entries.length - 1, failed: 1, unchecked: 0 });
    }
  });

  it("a cited entry taken out", async () => {
    const doc = structuredClone(example("get-invoice-evidence"));
    const [removed] = doc.entries.splice(1, 1);
    const result = await verifyEvidence(doc);
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toEqual([`Entry #${removed.seq} is cited but not in the document.`]);
    expect(result.counts).toMatchObject({ cited: doc.entries.length + 1, carried: doc.entries.length, failed: 0 });
  });

  it("two entries next to each other in the ledger that do not link, though each verifies alone", async () => {
    const key = signer();
    const first = key.sign(7, "0".repeat(64));
    const linked = evidenceOf([first, key.sign(8, first.hash)], key);
    expect(await verifyEvidence(linked)).toMatchObject({ ok: true, problems: [NOTE] });

    const broken = evidenceOf([first, key.sign(8, "1".repeat(64))], key);
    const result = await verifyEvidence(broken);
    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({ verified: 2, failed: 0 });
    expect(problemsOf(result)).toEqual(["Entry #8 does not follow entry #7: its prev_hash is not that entry's hash."]);

    // Entries apart in the ledger have others between them, which the document need not carry.
    expect(await verifyEvidence(evidenceOf([first, key.sign(9, "1".repeat(64))], key))).toMatchObject({ ok: true, problems: [NOTE] });
  });

  it("an entry carried twice", async () => {
    const doc = structuredClone(example("get-milestone-evidence"));
    doc.entries.push(structuredClone(doc.entries[0]));
    const result = await verifyEvidence(doc);
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toEqual([`Entry #${doc.entries[0].seq} is in the document twice.`]);
  });

  it.each([
    ["signature", { signature: "0".repeat(128) }],
    ["hash", { hash: "f".repeat(64) }],
    ["key id", { signingKeyId: "0".repeat(16) }],
  ])("a close pack row whose copy of its entry has another %s", async (_label, change) => {
    const doc = structuredClone(example("get-close-pack"));
    const row = (doc.rows as Array<{ paymentId: string; record: Record<string, unknown> & { seq: number } }>)[0];
    Object.assign(row.record, change);
    const result = await verifyEvidence(doc);
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toEqual([`The row for payment ${row.paymentId} names entry #${row.record.seq} with another hash or signature than the entry carries.`]);
  });

  it("a receipt that names its recording entry with another hash", async () => {
    const doc = structuredClone(example("get-invoice-receipt"));
    const records = doc.records as { seq: number; hash: string };
    records.hash = "f".repeat(64);
    const result = await verifyEvidence(doc);
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toEqual([`The receipt names entry #${records.seq} with another hash than the entry carries.`]);
  });

  it.each([
    ["the payee lock's change", (doc: Doc) => ((doc.changes as Array<{ change: { entry: number } }>)[0].change.entry = 9999)],
    ["the payee lock's confirmation", (doc: Doc) => ((doc.changes as Array<{ confirmation: { entry: number } }>)[0].confirmation.entry = 9999)],
    ["the payee lock's first payment", (doc: Doc) => ((doc.changes as Array<{ firstPayment: { entry: number } }>)[0].firstPayment.entry = 9999)],
    ["the payee lock's setting", (doc: Doc) => ((doc.lock as { changes: Array<{ entry: number }> }).changes[0].entry = 9999)],
    ["the payee lock's hold", (doc: Doc) => (doc.changes as Array<{ holds: Array<{ entry: number }> }>)[0].holds.push({ entry: 9999 })],
  ])("an entry cited by %s and not carried", async (_label, cite) => {
    const doc = structuredClone(example("get-payee-lock-evidence"));
    cite(doc);
    expect(problemsOf(await verifyEvidence(doc))).toContain("Entry #9999 is cited but not in the document.");
  });

  it.each([
    ["its invoice entry", (doc: Doc) => (doc.invoiceEntry = 9999)],
    ["its share", (doc: Doc) => ((doc.shared as { entry: number }).entry = 9999)],
    ["a change to its link", (doc: Doc) => (doc.shared as { changes: Array<{ entry: number }> }).changes.push({ entry: 9999 })],
    ["its recording entry", (doc: Doc) => ((doc.records as { seq: number }).seq = 9999)],
  ])("a receipt citing %s, not carried", async (_label, cite) => {
    const doc = structuredClone(example("get-invoice-receipt"));
    cite(doc);
    expect(problemsOf(await verifyEvidence(doc))).toContain("Entry #9999 is cited but not in the document.");
  });

  it.each([
    ["a row's entries", (doc: Doc) => (doc.rows as Array<{ entries: number[] }>)[0].entries.push(9999)],
    ["a row's record", (doc: Doc) => ((doc.rows as Array<{ record: { seq: number } }>)[0].record.seq = 9999)],
    ["an escrow move", (doc: Doc) => (doc.escrow as Array<{ entry: number }>).push({ entry: 9999 })],
  ])("a close pack citing %s, not carried", async (_label, cite) => {
    const doc = structuredClone(example("get-close-pack"));
    cite(doc);
    expect(problemsOf(await verifyEvidence(doc))).toContain("Entry #9999 is cited but not in the document.");
  });
});

describe("verifyEvidence with keys that did not sign (evidence API EA13)", () => {
  it("cannot check an entry whose key was not given: ok is null, never false", async () => {
    const doc = example("get-close-pack");
    const result = await verifyEvidence(doc, { keys: signer().pem });
    expect(result).toMatchObject({ ok: null, keys: "given" });
    expect(result.counts).toMatchObject({ verified: 0, failed: 0, unchecked: doc.entries.length });
    expect(result.problems).toEqual(doc.entries.map((entry) => `Entry #${entry.seq} could not be checked: The key that signed this entry is not known here.`));
  });

  it("does not use a key filed under another id, given or carried", async () => {
    const doc = structuredClone(example("get-invoice-evidence"));
    expect((await verifyEvidence(doc, { keys: { ["0".repeat(16)]: doc.keys[0].publicKeyPem } })).ok).toBeNull();
    doc.keys[0].id = "0".repeat(16);
    expect((await verifyEvidence(doc)).ok).toBeNull();
  });

  it("checks entries of a retired key with that key, and says only that the others could not be checked", async () => {
    const retired = signer();
    const active = signer();
    const first = retired.sign(7, "0".repeat(64));
    const second = active.sign(8, first.hash);
    const doc = { ...evidenceOf([first, second], active), keys: [{ id: retired.keyId, status: "retired", publicKeyPem: retired.pem }, { id: active.keyId, status: "active", publicKeyPem: active.pem }] };
    expect(await verifyEvidence(doc)).toMatchObject({ ok: true, counts: { verified: 2 } });
    const onlyActive = await verifyEvidence(doc, { keys: active.pem });
    expect(onlyActive).toMatchObject({ ok: null, counts: { verified: 1, unchecked: 1, failed: 0 } });
    expect(onlyActive.problems).toEqual(["Entry #7 could not be checked: The key that signed this entry is not known here."]);
  });
});

describe("verifyEvidence on what is not a document", () => {
  it("answers true for an empty month, which carries no entry", async () => {
    const doc = { ...example("get-close-pack"), rows: [], notSettled: [], escrow: [], entries: [] };
    const result = await verifyEvidence(doc, { keys: keysOf(doc) });
    expect(result).toEqual({ ok: true, format: "vestiarion-close-pack/1", keys: "given", entries: [], counts: { cited: 0, carried: 0, verified: 0, failed: 0, unchecked: 0 }, problems: [] });
  });

  it("knows the four formats", () => {
    expect(EVIDENCE_FORMATS).toEqual(["vestiarion-evidence/1", "vestiarion-payee-lock-evidence/1", "vestiarion-receipt/1", "vestiarion-close-pack/1"]);
  });

  const NOT_A_DOCUMENT =
    "verifyEvidence takes a Vestiarion evidence document: an object whose format is vestiarion-evidence/1, vestiarion-payee-lock-evidence/1, vestiarion-receipt/1 or vestiarion-close-pack/1.";
  it.each([
    ["nothing", null],
    ["text", "vestiarion-evidence/1"],
    ["a list", [example("get-invoice-evidence")]],
    ["another format", { format: "vestiarion-audit/1", entries: [] }],
    ["no format", { entries: [] }],
  ])("throws a TypeError for %s", async (_label, value) => {
    await expect(verifyEvidence(value)).rejects.toThrow(new TypeError(NOT_A_DOCUMENT));
  });

  it("asks for the answer's data when given the whole answer", async () => {
    await expect(verifyEvidence({ data: example("get-close-pack") })).rejects.toThrow(new TypeError("Pass the document itself, the answer's data, not the whole answer."));
  });

  it("throws when the document carries no list of entries", async () => {
    await expect(verifyEvidence({ format: "vestiarion-receipt/1" })).rejects.toThrow(new TypeError("The document carries no list of entries to check."));
    await expect(verifyEvidence({ format: "vestiarion-receipt/1", entries: "5610" })).rejects.toThrow(new TypeError("The document carries no list of entries to check."));
  });

  it("throws when keys are neither a PEM nor a map of key id to PEM", async () => {
    await expect(verifyEvidence(example("get-invoice-receipt"), { keys: 42 as unknown as string })).rejects.toThrow(TypeError);
  });

  it("names an entry that is not a ledger entry as failing, without throwing", async () => {
    const doc = structuredClone(example("get-invoice-receipt"));
    (doc.entries as unknown[]).push({ seq: 9000 });
    const result = await verifyEvidence(doc);
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toEqual(["Entry #9000 does not verify: The entry's content does not match its body hash."]);
  });

  it.each([["text", "5610"], ["nothing", null], ["an entry with no seq", { summary: "Paid" }]])("names %s in the list of entries as a problem, without throwing", async (_label, item) => {
    const doc = structuredClone(example("get-invoice-receipt"));
    (doc.entries as unknown[]).push(item);
    const result = await verifyEvidence(doc);
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toEqual(["The document's list of entries holds something that is not a ledger entry."]);
    expect(result.counts).toMatchObject({ carried: doc.entries.length, verified: doc.entries.length - 1, failed: 1 });
  });
});
