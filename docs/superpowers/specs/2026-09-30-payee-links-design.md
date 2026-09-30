# Payee links: a payee enters their own Arc address

Date: 2026-09-30. Status: approved for implementation (decided under the standing autonomy grant;
rulings carry their cost if wrong).

## 1. Why

Before the agent can pay a vendor or a contractor, the business has to collect that payee's Arc
wallet address. Someone emails the payee, waits for a reply, and copies 42 characters into
Vestiarion by hand, once per payee. It is the slowest step between signing up and making a first
payment, and a hand-copied address is how payments go astray.

A payee link removes that step. An owner or admin copies a one-time link from the payee's card and
sends it. The payee opens it without an account and enters their own address. As with any address
change, the agent then holds payments to that address until a member confirms it.

## 2. Flow

1. **Create.** On Counterparties, an owner or admin chooses **Ask for address** on a payee's card.
   Vestiarion creates a link that works once and expires in 7 days, and shows it once, with a copy
   button. Creating a new link revokes the payee's previous unused one.
   - Ledger: `payee_link_created { by, counterpartyId, linkId, expiresAt }`.
2. **Open.** The payee opens `/payee/<token>` and sees:
   - which business wants to pay them, and under which payee name (the workspace name and the
     counterparty name);
   - that payment is in USDC on Arc testnet;
   - one field: their Arc address.
   
   An expired, used, revoked or unknown link shows the same neutral message, "This link is no
   longer valid; ask the business that sent it for a new one", and nothing about any workspace.
3. **Submit.** Checking the address and claiming the link happen in one step:
   - The address must be 0x followed by 40 hex characters.
   - The link is claimed atomically (compare-and-set on `used_at`), so it works once.
   - The address change goes through the existing `changeCounterpartyAddress`. It stamps
     `address_changed_at`, and the agent then holds every payment to that address until a member
     confirms it, by approving a payment or with **Confirm address**.
   - Ledger: `counterparty_address_changed { by: null, via: "payee_link", linkId, counterpartyId, from, to }`.
   - The payee sees: "Thanks. *Business* will confirm your address before paying you."
   - Submitting the address already on file uses the link and says so: "That is already the
     address on file."
   - Any other failure puts the link back, so the payee can try again.
4. **Revoke.** While a link is unused, the card shows "Address link sent · expires *date*", with
   **Revoke**. Ledger: `payee_link_revoked { by, counterpartyId, linkId }`.
5. **Confirm.** The member's existing **Confirm address** raises `address_confirmed`, and the agent
   decides the held payments within a minute (event-driven cycles).

## 3. Data

Migration `0039_payee_links.sql` (0038 is taken by the payment-timing branch):

- **`payee_links`**
  - Columns:
    - `id`
    - `org_id` → orgs, on delete cascade
    - `counterparty_id` → counterparties, on delete cascade, with the composite `(org_id, counterparty_id)`
    - `token_hash` (unique; 64 hex characters, the sha256 of the secret)
    - `created_by` → auth.users, on delete set null
    - `created_at`, `expires_at`, `used_at`, `revoked_at`
  - It is a platform table like `api_keys`: RLS on, no policies, and only the service role can read
    or write it.
- **`create_payee_link(p_org_id, p_counterparty_id, p_token_hash, p_by, p_expires_at)`** (definer)
  - Serialised per counterparty with an advisory lock.
  - Refuses a counterparty outside the workspace with `counterparty_not_found`.
  - Revokes that counterparty's unused links, then inserts the new one.
- **`payee_link_preview(p_token_hash)`** returns `(org_name, counterparty_name, expires_at)` for a
  link that is still usable, and no row for any other link.
- **`claim_payee_link(p_token_hash)`** sets `used_at = now()` only on a link that is unused,
  unrevoked and unexpired, and returns `(link_id, org_id, counterparty_id)`. It returns no row for
  any other link.
- **`release_payee_link(p_link_id)`** clears `used_at`.
- **`revoke_payee_link(p_org_id, p_link_id, p_by)`** revokes an unused link of that workspace.

The token looks like `vxp_<43 base64url characters>` (32 random bytes). Only its hash is stored.

## 4. Rulings

- **R1: the payee's address always waits for a member.** Anyone who gets hold of the link can
  submit an address, but no money moves until a member confirms that exact address. This is the
  existing guard against payment redirection. Cost if wrong: none for money; at worst a confirmation
  step the business would rather skip.
- **R2: one use, 7 days, one unused link per payee.** A new link revokes the old one. Cost if wrong:
  a payee whose link lapsed needs a new one.
- **R3: no rate limit on the public page.** The token has 256 bits and is checked by hash, and a
  wrong token learns nothing. Cost if wrong: load, which Vercel absorbs.
- **R4: the page names the business and the payee**, because a payee needs to know who is asking.
  It never shows the current address, amounts, invoices or anything else. Cost if wrong: a leaked
  link shows two names.
- **R5: analytics never see the token.** `redactPath` turns `/payee/<token>` into `/payee/:token`.
  The page is also `noindex`.

## 5. Pieces

- The migration, plus the new table and functions in `PLATFORM_TABLES` and `PLATFORM_RPCS`.
- `src/lib/platform/payee-links.ts`: `generatePayeeLinkToken`, `createPayeeLink`, `listActivePayeeLinks`,
  `revokePayeeLink`, `previewPayeeLink`, `submitPayeeAddress`.
- `src/lib/counterparty-address.ts`: `changeCounterpartyAddress` accepts `actor: { userId } | { payeeLinkId }`.
- Actions:
  - `src/app/actions/payee-links.ts`: create and revoke, which need `records.write`.
  - The public page's submit action, which needs no session.
- `src/app/payee/[token]/page.tsx`, and the card control `src/components/intake/PayeeLinkControl.tsx`.
- `src/lib/analytics/redact.ts`: the `/payee/` rule.
- Docs: a "Ask a payee for their address" section in the first-payment guide, and a changelog
  entry for the new ledger actions and the `via: "payee_link"` detail.

## 6. Tests

- **PGlite:**
  - the grants;
  - `create_payee_link` revokes the previous link and refuses a foreign counterparty;
  - claim works once, never on an expired or revoked link, and release lets it be claimed again;
  - preview says nothing for an unusable link;
  - revoke stays inside its workspace;
  - the `auth.users` foreign-key inventory.
- **Library** (fake Supabase):
  - token shape and hash;
  - submit order: address check, then claim, then change;
  - release on failure;
  - an unchanged address uses the link;
  - the ledger `via`.
- **Actions:** the permission is enforced, and the token is shown only in the create result.
- **Page:** each state; the neutral message for every unusable link; no current address or
  workspace detail for an unusable link; `noindex`.
- **Analytics:** the redaction.

## 7. Rollout

1. The partner runs `npm run db:migrate` (0039).
2. Merge.
3. In testnet-2, create a link for a counterparty, open it in a private window, and submit an
   address. The card then shows it unconfirmed.
4. Confirm it. `address_confirmed` starts an event cycle.
5. Record the result here.

## 8. Rollout record

(pending)
