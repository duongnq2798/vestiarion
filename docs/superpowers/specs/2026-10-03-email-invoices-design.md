# Invoices by email: a workspace address that turns a forwarded invoice into a draft a person adds

Date: 2026-10-03. Status: designed on `feat/email-invoices`. Roadmap row INT1b; integrations design §9 (email-in after
Slack). Decided under the standing autonomy grant; the partner said "ok tiếp đi" to the proposal.

## 1. The problem

Suppliers send invoices by email. Today a member downloads the PDF and uploads it (From a document on AP / AR), or
sends it to the Telegram bot or picks it in Slack. Every small business already has the email: forwarding it should be
enough.

## 2. What this builds

Each workspace can turn on one address, `invoices-<code>@<inbound domain>`. An email sent or forwarded there is read the
way From a document reads one, into a draft on AP / AR, and a person adds it with one press, or dismisses it. The agent
then decides the payable as any other. If the workspace has Slack, its channel is told an invoice arrived.

## 3. Rulings

- **E1. Provider.** Resend Receiving, since the app already sends through Resend. The inbound domain comes from
  `INBOUND_EMAIL_DOMAIN`: Resend's managed `<id>.resend.app`, which receives at any address with no DNS, or a subdomain
  with Resend's MX record. The feature is on only when `INBOUND_EMAIL_DOMAIN`, `RESEND_INBOUND_WEBHOOK_SECRET` and a key
  that may read received emails (`RESEND_RECEIVING_API_KEY`, else `RESEND_API_KEY`) are all set; the route answers 404
  otherwise, and Settings shows nothing.
- **E2. One address per workspace.** `invoices-<code>@<domain>`, the code 12 characters of base32 (60 bits), so it
  cannot be guessed. An owner or admin (`integrations.manage`) turns it on, takes a new address (the old one stops at
  once) or turns it off. Kept in `invoice_inboxes`, a platform table. Recorded as `invoice_inbox_on`,
  `invoice_inbox_changed` and `invoice_inbox_off`, without the address: knowing it lets anyone file a draft.
- **E3. The webhook.** `POST /api/email/inbound`, checked against the Svix signature Resend sends (`svix-id`,
  `svix-timestamp`, `svix-signature`: HMAC-SHA256 over `id.timestamp.body` with the secret after `whsec_`, any of the
  `v1,` signatures, five minutes either way) over the raw body before anything is read. Only `email.received`. The
  workspace is the first recipient (`to`, `cc`, `received_for`) at the inbound domain whose local part is an active
  inbox's; none, and nothing is stored. Resend's email id is unique per workspace, so a redelivery stores nothing new.
- **E4. Answered at once.** The row is stored as `received` and the route answers 200; the reading runs after the
  response. A failure marks the row `unreadable` with a reason a person sees: nothing is lost silently.
- **E5. Reading.** `GET /emails/receiving/{id}` gives the sender, the subject, the text, SPF, DKIM and DMARC, and the
  attachments' metadata. The first attachment that is a PDF, an `.eml` or a `.txt` of at most 4 MB is fetched through
  `GET /emails/receiving/{id}/attachments/{aid}` and its `download_url` (https, Resend's hosts only); with none, the
  email's text is read. `readInvoiceDraft` reads it; the draft rule every chat shares (`chatDraftOf`) decides whether
  it can be added. The row becomes `ready`, `needs_details` (with the reasons) or `unreadable`. Five reads a minute per
  workspace, as everywhere.
- **E6. Nothing is added by itself.** A sender address is easy to fake, so a person adds every draft. The inbox shows
  whether the sender passed SPF, DKIM and DMARC, and whether it is a counterparty's billing email: information, never
  authority.
- **E7. The inbox.** AP / AR shows the emails still to decide, newest first: sender, subject, when, the fields read,
  warnings and the model's note. An owner or admin gets **Add, goods received**, **Add, not received yet** and
  **Dismiss**; a draft that cannot be added says why and offers Dismiss. A draft is added once: the status moves from
  `ready` to `added` in one guarded update.
- **E8. Adding.** `addInvoice` as the member, through the command layer; `create_invoice` names `via: "email"` and
  `inboxEmailId`, with the document's kind, hash and reader. The agent decides it as any payable.
- **E9. Slack.** A workspace with Slack has its channel told: "New invoice by email from …: amount, due … Review it in
  AP / AR", with the link. Best effort; no buttons in this version.
- **E10. Ledger.** `invoice_email_received` (actor system, domain ap): `{ inboxEmailId, from, authentication, read,
  document }`, the sender's address with most of its name hidden. `invoice_email_dismissed` (human): `{ by,
  inboxEmailId }`.
- **E11. Data (migration 0068, the number kept for this).** `invoice_inboxes` (platform: org unique, code unique,
  created_by). `inbox_emails` (tenant, RLS like `ar_reminders`): Resend's id unique per workspace, sender, subject,
  received_at, status, reasons, the fields read, the draft, the authentication results, the invoice it became, who
  decided and when. Both go with their workspace.
- **E12. What is kept.** The sender, the subject and what was read; the document itself is not kept, only its hash, as
  From a document. The privacy page names Resend as receiving the forwarded email.

## 4. Testing

PGlite for 0068 (RLS, uniqueness, cascade, re-run); the signature check (good, tampered, stale, multiple signatures);
the Resend client (paths, key, host checks, size); routing an address to its workspace; the receive flow (stored, read,
`ready` / `needs_details` / `unreadable`, redelivery, unknown address, Slack told); the inbox actions (add once, as the
member, `via: "email"`; dismiss; roles); the docs-guides quotes.

## 5. Rollout

1. Apply 0068 in prod (the partner).
2. In Resend: Emails → Receiving gives the `<id>.resend.app` domain; Webhooks → add
   `https://www.vestiarion.xyz/api/email/inbound` for `email.received` and copy the signing secret. A key with full
   access can read received emails.
3. Vercel: `INBOUND_EMAIL_DOMAIN`, `RESEND_INBOUND_WEBHOOK_SECRET`, and `RESEND_RECEIVING_API_KEY` if the sending key
   cannot read. Redeploy.
4. testnet-2: Settings → Invoices by email → Turn on; forward the test PDF to the address; Add from AP / AR; the agent
   decides; the Slack channel was told.
