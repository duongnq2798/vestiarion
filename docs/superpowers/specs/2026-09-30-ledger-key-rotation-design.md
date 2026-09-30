# Ledger key rotation: an owner replaces a workspace's signing key, and its history still verifies

Every workspace signs its ledger with its own Ed25519 key, stored encrypted on the workspace (`orgs.ledger_signing_key_enc`). Rotation already has half its machinery:
- entries carry `signing_key_id`;
- `verifyChain` accepts a keyring of an active key plus retired ones;
- `detectKeyRotation` writes a `ledger_key_rotated` entry signed by the new key;
- the audit export's verifier takes several keys.

The other half is missing. Retired keys come only from the environment variable `LEDGER_RETIRED_PUBLIC_KEYS`, and only the founding workspace receives it (`orgConfig`, "only the founding chain has ever rotated"). A self-serve workspace has nowhere to keep a retired public key, so replacing its key today would make its whole history NOT CHECKED. There is also no way to replace a key except by hand in the database. The rotation write path has never run against a real ledger (roadmap, stage 4).

This design lets an owner rotate a workspace's key from Settings. Every entry, before and after, keeps verifying on the Audit log page, through `/api/ledger/verify` and in an exported file.

It was decided on 2026-09-30 by the implementer under the partner's standing instruction.

## 1. What this builds

- **Migration 0035:** `orgs.ledger_retired_keys jsonb not null default '[]'`, an array of `{ id, publicKeyPem, retiredAt }`. It holds public material only. It is written by the service role and read by `orgConfig`, like the rest of the org row.
- **`orgConfig`** gives every workspace the public keys from its own `ledger_retired_keys` as `ledgerRetiredPublicKeys`. The founding workspace also keeps the environment's bundle, joined with its column. The keyring, `verifyChain`, `detectKeyRotation` and the audit export then see a workspace's retired keys with no further change.
- **`rotateLedgerKey({ orgId, actorId })`** in `src/lib/platform/ledger-key.ts`:
  1. Refuses unless the actor is an owner (`org.administer`, checked by the server action).
  2. Refuses while a cycle is running (the 15-minute `cycle_runs` check).
  3. Reads the org row and opens the current signing key. It refuses when the key cannot be opened, because retiring a key that cannot be read would lose its public half.
  4. Generates a new Ed25519 key and seals it to the org and column (`encryptSecret`).
  5. In one conditional update, sets `ledger_signing_key_enc` to the new envelope and appends `{ id, publicKeyPem, retiredAt }` for the old key to `ledger_retired_keys`. The update applies only where `ledger_signing_key_enc->>iv` still equals the envelope it read, so two owners rotating at once cannot both win, and the loser changes nothing.
  6. Enters a fresh scope, which reads the new configuration, and writes the rotation entry with `recordLedgerKeyRotation(actorId)`: `system/ledger_key_rotated`, actor `human`, detail `{ from, to, by }`, signed by the new key. Because the head is then signed by the new key, the automatic detection in later appends finds nothing to record.
  7. Returns `{ from, to }`. The old private key is never stored, logged or returned: after rotation it exists nowhere.
- **Settings, "Ledger signing key" panel:**
  - Every member who sees Settings sees the current key id and the retired key ids with the time each was retired.
  - Owners also get **Rotate signing key**, behind a confirmation: "New entries are signed by a new key. Entries already written keep verifying with the old public key, which stays listed here. The old private key is discarded and cannot sign again."
  - Other roles see "An owner of this workspace can rotate the key."
- **The Audit log page's public-key disclosure** lists the retired public keys, with their ids, under the active one. An auditor pinning keys with `--public-key` needs all of them.
- **Docs:** the audit-export guide says where the keys come from after a rotation (Audit log page, every key listed). A short "Rotate the signing key" section in the same guide says what rotating does and when to do it (a suspected leak, a routine change).

## 2. Decisions

- **K1. The retired keys live on the workspace, as public PEMs in jsonb.** They are not secrets, so they need no envelope, and one column read with the org row keeps `orgConfig` a single query. An array keeps the history of more than one rotation in order.
- **K2. One conditional update does the swap and the retirement together.** There is never a moment when the new key signs and the old one is not yet retired. That would make the next entries verify while every earlier entry stops verifying. The condition on the envelope's IV is the same pattern go-live uses for Circle credentials.
- **K3. The rotation entry is written by the rotation, with who did it.** `detectKeyRotation` stays as the safety net for the rare case this misses: a cycle that entered its scope with the old key before the swap. Such a cycle can still append entries signed by the old key after the rotation. They verify, because the old key is retired but known. Detection then writes one more `ledger_key_rotated` entry once the head is signed by the new key again. Both statements are true.
- **K4. Refused while a cycle runs.** That keeps K3's case rare. A running cycle holds the old configuration in its scope.
- **K5. The old private key is discarded.** Retiring means it can never sign again. Keeping it, even encrypted, would keep alive the thing a rotation after a leak is meant to kill.
- **K6. The founding workspace rotates the same way.** Its environment bundle keeps working (read and joined), so nothing about its existing verification changes. After its first rotation from Settings, its retired key lives in the column like everyone else's.
- **K7. No `/api/v1` change.** `GET /api/v1/ledger` already returns `signingKeyId` per entry, and the status payload's key count stays a count. There is no changelog entry.

## 3. Components

```
supabase/migrations/0035_ledger_retired_keys.sql   the column, public data, service-role write
src/lib/dal/org-config.ts                          OrgRow gains ledger_retired_keys; ORG_SECRET_COLUMNS selects it; retired PEMs into config
src/lib/ledger.ts                                  recordLedgerKeyRotation(by)
src/lib/platform/ledger-key.ts                     rotateLedgerKey(), ledgerKeyStatus(), LedgerKeyError
src/app/actions/ledger-key.ts                      rotateLedgerKeyAction (org.administer)
src/components/LedgerKeyPanel.tsx                  the Settings panel
src/app/o/[slug]/settings/page.tsx                 renders it
src/app/o/[slug]/audit/page.tsx                    retired keys in the public-key disclosure
content/docs/guides/audit-export.mdx               rotation section
```

## 4. Testing

- **Migration (PGlite):**
  - the column's type, default and not-null;
  - the tenant role cannot update it;
  - existing orgs read `[]`.
- **`orgConfig`:**
  - retired PEMs from the column;
  - founding joins the environment's bundle and the column;
  - a malformed entry is skipped with a warning, never fatal on the read path.
- **`rotateLedgerKey`**, against the recording fake:
  - the update's body carries the new envelope (it opens to a key whose id is the returned `to`) and the old public key appended;
  - the update is conditional on the old IV;
  - a lost race changes nothing and records nothing;
  - it refuses while a cycle runs, and refuses an unreadable current key;
  - the ledger entry is `ledger_key_rotated` `{ from, to, by }`, signed by the new key;
  - no private PEM appears in any request other than inside the sealed envelope.
- **End to end, in memory:**
  - a chain signed by key A, rotated to key B, then continued, verifies with `verifyChain` over the org's new keyring;
  - the audit export of it passes the standalone verifier, with both keys pinned and with the file's keys;
  - pinning only B answers NOT CHECKED.
- **The panel:**
  - the owner sees the button and the confirmation text;
  - an admin or viewer sees the ids and no button;
  - it names the retired keys.
- **The action:** `org.administer`, the `LedgerKeyError` messages, and revalidation.

## 5. Rollout

1. Apply `0035` before the merge. It is additive: old code never selects the column.
2. Merge on green.
3. On a sandbox the partner owns (e.g. `test-sample-data`), rotate from Settings, then run a cycle. Then check:
   - the `ledger_key_rotated` entry names both ids and the owner's id;
   - `/api/ledger/verify` is valid;
   - the audit export lists two keys and passes the verifier, while pinning only the new key answers NOT CHECKED;
   - the Audit log page lists the retired key.
4. Record the result in this spec.

## 6. Out of scope

- Rotating on a schedule.
- Recovering a lost key: without its public half nothing can verify, which is why rotation refuses an unreadable key.
- Revoking a retired key. A leaked key's past signatures stay as valid as they were, and the rotation entry marks the point after which it no longer signs.
- Rotating the platform master key (`VESTIARION_MASTER_KEYS`), which is a different key.
