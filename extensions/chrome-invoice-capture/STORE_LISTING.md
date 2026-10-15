# Vestiarion Invoice Capture: Chrome Web Store listing

The text to paste into the Chrome Web Store's developer dashboard, field by field. `tests/chrome-extension-manifest.test.ts`
holds the permission list below to `extension/manifest.json`.

## Name

Vestiarion Invoice Capture

## Summary (132 characters at most)

Capture an invoice you select or choose, check its fields, and send it as a draft to your Vestiarion workspace.

## Category

Workflow & Planning

## Language

English

## Description

Vestiarion Invoice Capture turns an invoice in your browser into a draft in your Vestiarion workspace, for you or a
colleague to check and add as a bill. Vestiarion is a treasury agent that pays bills in USDC on Arc; this extension only
brings invoices to it.

How it works:

1. Connect the extension to your Vestiarion workspace. You sign in to Vestiarion and allow it; the extension never sees
   your password or an API key.
2. On a supplier's portal, in a web mail or in a PDF, select the invoice's text and press Capture selected text, or
   right-click the selection and choose Capture invoice with Vestiarion. Or choose the invoice's file (a PDF with text,
   a .txt or an .eml file, up to 4 MB).
3. Vestiarion reads the supplier, invoice number, amount, currency, invoice date, due date, purchase order and memo,
   with its model provider (DeepSeek, on the hosted service), as it does for any invoice uploaded to it. Check each
   field; the extension says
   which ones are missing.
4. Press Send draft. The draft waits under Captured drafts on Bills & receivables in Vestiarion, where an owner or admin
   adds it as a bill, with every check a bill goes through, or discards it.

### What it does not do

- It does not add a bill, approve a payment, pay anything or touch a wallet. A draft becomes a bill only when a person
  adds it in Vestiarion.
- It does not read a page by itself. It reads the text you selected, once, when you press Capture selected text or
  choose Capture invoice with Vestiarion, and nothing else of the page.
- It does not see your bills, counterparties, members, wallets or API keys. It can read only the drafts it created.
- It does not send anything anywhere but Vestiarion, at www.vestiarion.xyz. Vestiarion reads what you capture as it
  reads any invoice uploaded to it: the model provider (DeepSeek, on the hosted service) sees its text, under that
  provider's own API terms (https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html) and
  privacy policy (https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html).
- It does not track you: no analytics, no advertising, and nothing about your invoices is counted.

## Single purpose

Capture invoice information the user explicitly selects or uploads, let the user review the extracted fields, and send a
draft to the user's Vestiarion workspace.

## Permission justifications

- `activeTab`: when the person presses Capture selected text, or chooses Capture invoice with Vestiarion on a selection,
  the extension reads the selected text in that one tab, for that one action. It has no access to any page otherwise.
- `scripting`: runs the one function that returns the current selection's text in the active tab, after that press. No
  other script is ever run in a page.
- `storage`: keeps the connection's refresh token, the workspace's name, whether the first-run screen was read, and the
  draft being checked, on this computer; the access token, and a selection captured from the context menu until the
  person sends or drops it (5 minutes at most), only in session storage, in memory.
- `identity`: `chrome.identity.launchWebAuthFlow` opens Vestiarion's sign-in and consent page so the person connects
  their workspace with OAuth (authorization code with PKCE), without an API key in the extension.
- `contextMenus`: adds Capture invoice with Vestiarion to the menu shown on a text selection.
- `alarms`: removes a selection captured from the context menu 5 minutes after it was taken, if the person has not
  sent or dropped it, whether or not the popup opens again.

Host permissions: none. The extension's calls go to www.vestiarion.xyz alone, as cross-origin requests that
Vestiarion answers with CORS for this extension's id, never with cookies.

Remote code: No. Every script is in the package; there is no `eval`, no remote script and no CDN.

## Privacy

Privacy policy: https://www.vestiarion.xyz/privacy#chrome-extension

### Data usage (the dashboard's checkboxes)

What the extension collects, only when the person captures an invoice:

- Website content: yes. The text the person selects, when they press Capture.
- Financial and payment information: yes. An invoice's amount, currency, dates and any payment details written on it,
  in the text or file the person captures.
- Personal communications: yes, only when the person captures text from an email or chooses an .eml file.
- Authentication information: yes. The connection's refresh token, kept in the extension's local storage, and its
  access token, kept in memory; both are sent only to www.vestiarion.xyz.
- Personally identifiable information: only what an invoice the person captures contains, such as a supplier's name.
- Health information, location, web history, user activity: no.

### Certifications

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Retention, as the privacy policy says it

The captured text is kept with the draft until a person adds it as a bill or discards it, and at most 30 days. A draft
never sent is deleted within 7 days. A file is never kept, only its SHA-256. The model provider (DeepSeek, on the hosted
service) sees the text under its own API terms and privacy policy, as the privacy policy says. Disconnecting revokes the tokens at once, and a connection lasts
at most 90 days.

## Test instructions for the reviewer

1. Create a free workspace at https://www.vestiarion.xyz/signup (an email sign-in link, no password). You are its owner.
2. Sign in to Vestiarion in a tab, then click the extension's icon, read Before you start, press Continue, then Connect
   Vestiarion, choose the workspace and press Allow.
3. Open any page with an invoice's text, for instance a plain text invoice, select it and press Capture selected text.
   Check the fields and press Send draft, then Open in Vestiarion: the draft is under Captured drafts.

## Screenshots to make (1280 × 800)

1. The popup's Before you start screen.
2. The consent page, Connect Vestiarion Invoice Capture, with It can and It cannot.
3. The popup checking a captured invoice, a missing field named.
4. Sent for review, with Open in Vestiarion.
5. Captured drafts on Bills & receivables, with Review and add as bill.
