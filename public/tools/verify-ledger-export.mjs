#!/usr/bin/env node
// public/tools/verify-ledger-export.mjs
//
// Checks a Vestiarion audit export (format vestiarion-ledger-export/1) with
// nothing but Node.js: no Vestiarion code, no network. For every entry it
// recomputes the body hash from canonical JSON, checks the Ed25519 signature
// against the key the entry names, and follows the hash links from genesis.
//
//   node verify-ledger-export.mjs export.json [--public-key key.pem]
//
// Exit 0: VALID. Exit 1: BROKEN (the entry and the reason are printed).
// Exit 2: NOT CHECKED (an unknown key, or a file that is not an export).
//
// The file carries its own public keys, so it can only prove it is consistent
// with itself. Compare the key id and head hash printed below with the ones on
// the workspace's Audit page, or pass --public-key with the key you trust.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const GENESIS = "0".repeat(64);

function out(line) {
  process.stdout.write(`${line}\n`);
}

function finish(code, first, ...rest) {
  out(first);
  for (const line of rest) out(line);
  process.exit(code);
}

// The same canonical form the ledger signs: object keys sorted, no whitespace,
// undefined members dropped, arrays in order.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const members = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${members.join(",")}}`;
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// First 16 hex characters of sha256 over the key's SPKI DER form.
function keyId(key) {
  return crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

const args = process.argv.slice(2);
const pinIndex = args.indexOf("--public-key");
const pinPath = pinIndex >= 0 ? args[pinIndex + 1] : undefined;
const file = args.find((arg, i) => !arg.startsWith("--") && (pinIndex < 0 || i !== pinIndex + 1));
if (!file || (pinIndex >= 0 && !pinPath)) {
  finish(2, "NOT CHECKED: usage: node verify-ledger-export.mjs <export.json> [--public-key <key.pem>]");
}

let doc;
try {
  doc = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  finish(2, `NOT CHECKED: ${file} could not be read as JSON (${error.message})`);
}
if (doc?.format !== "vestiarion-ledger-export/1" || !Array.isArray(doc.entries) || !Array.isArray(doc.keys)) {
  finish(2, `NOT CHECKED: ${file} is not a Vestiarion ledger export (format vestiarion-ledger-export/1)`);
}

const known = new Map();
try {
  if (pinPath) {
    const key = crypto.createPublicKey(readFileSync(pinPath, "utf8"));
    known.set(keyId(key), key);
  } else {
    for (const entry of doc.keys) {
      const key = crypto.createPublicKey(entry.publicKeyPem);
      known.set(keyId(key), key);
    }
  }
} catch (error) {
  finish(2, `NOT CHECKED: a public key could not be read (${error.message})`);
}
if (known.size === 0) finish(2, "NOT CHECKED: no public key to check the signatures with");

const trusted = [...known.keys()].join(", ");
let expectedPrev = GENESIS;

for (const entry of doc.entries) {
  const at = `entry #${entry.seq}`;
  const bodyHash = sha256(
    canonicalJson({ actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail })
  );
  if (bodyHash !== entry.body_hash) finish(1, `BROKEN at ${at}: its content does not match its recorded body hash`);

  let candidates;
  if (entry.signing_key_id) {
    const key = known.get(entry.signing_key_id);
    if (!key) {
      finish(2, `NOT CHECKED: ${at} was signed by key ${entry.signing_key_id}, which is not among the trusted keys (${trusted})`);
    }
    candidates = [key];
  } else {
    // Entries written before key ids existed name no key; any trusted key may have signed them.
    candidates = [...known.values()];
  }
  const signed = candidates.some((key) =>
    crypto.verify(null, Buffer.from(entry.body_hash, "hex"), key, Buffer.from(entry.signature, "hex"))
  );
  if (!signed) finish(1, `BROKEN at ${at}: its signature does not verify against the trusted keys (${trusted})`);

  if (entry.prev_hash !== expectedPrev) finish(1, `BROKEN at ${at}: prev_hash does not match the preceding entry's hash`);
  if (sha256(entry.prev_hash + entry.body_hash + entry.signature) !== entry.hash) {
    finish(1, `BROKEN at ${at}: its hash does not match prev_hash + body_hash + signature`);
  }
  expectedPrev = entry.hash;
}

const last = doc.entries[doc.entries.length - 1];
if (last && (doc.head?.seq !== last.seq || doc.head?.hash !== last.hash)) {
  finish(1, `BROKEN: the file's head does not name its last entry (#${last.seq})`);
}

finish(
  0,
  `VALID: ${doc.entries.length} entries of ${doc.workspace?.slug ?? "this workspace"}, each signed and linked from genesis`,
  `Head: ${last ? `#${last.seq} ${last.hash}` : "none (empty chain)"}`,
  `Trusted key id${known.size === 1 ? "" : "s"}: ${trusted}${pinPath ? " (from --public-key)" : " (from the file itself)"}`,
  pinPath
    ? "The signatures were checked against the key you supplied."
    : "The file vouches for itself: compare this key id and head hash with the workspace's Audit page before relying on it."
);
