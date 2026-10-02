# Getting paid, from the freelancer's side

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong). Follows pay a freelancer
(`2026-10-01-pay-a-freelancer-design.md`) and payee links (`2026-09-30-payee-links-design.md`).

## 1. Why

Pay a freelancer made the business's side one form. The freelancer's side is still thin.

- They get an email and open a page with one field.
- They paste an address and read "Thanks".
- The link then stops working, so they see nothing more: not when the business confirms the
  address, not when the money is sent, and not a transaction to check.

The page never says how much they are being paid, or for what, though the email does. A first-time
freelancer, who may never have used a wallet on Arc, has no way to tell whether something went
wrong.

## 2. What it does

The payee link becomes the freelancer's whole journey, in three steps, always labelled:

1. **Your address**: what they are being paid and for what, how it works, and one field. A second
   screen shows the address back in readable groups with a three-point checklist before it is sent.
2. **Confirmation**: after sending, the same link shows that the business is confirming the address,
   and why a person does that.
3. **Payment**: once confirmed, each payment's status in plain words, ending in a confirmation
   screen. It shows the amount, who paid, for what, the address it went to, when, and the
   transaction on Arc testnet.

The page refreshes itself while something is in progress. The email tells the freelancer that the
same link shows their status. A public guide, "Get paid as a freelancer", walks through it with
screenshots of these screens.

## 3. Rulings

- **R1 — a used link shows status, not nothing.**
  - Payee links R4 had every unusable link show one sentence and name no one. A used link now
    shows its payee's status for 30 days after it was used.
  - It moves nothing, and changes nothing. The address still waits for a member's confirmation
    (payee links R1).
  - A revoked, expired-unused or unknown link still shows the one sentence.
  - Cost if wrong: whoever holds a used link learns, for 30 days, the business's name, the payee's
    name, what they are paid, and a masked address. That is what the payee's own email already
    says, and the token is 32 random bytes.
- **R2 — what counts as the payee's payments.** All of the following, newest ten:
  - every milestone or payable for that counterparty that is not rejected and not yet paid;
  - every one paid since the link was made (less a day, for a payment made the same morning).

  Older history is not shown. Cost if wrong: a vendor with a long history sees only recent payments.
- **R3 — no reasons for a hold.** A payment held, flagged or waiting for information reads "With
  {business} for review". The page never says why: a screening match or a fraud flag is the
  business's to discuss, not a stranger-with-the-link's to read.
- **R4 — the address is masked** (`0x1234…abcd`) everywhere on the page except the check screen,
  where the payee sees in full what they typed.
- **R5 — one primary action per screen.** Continue, then Send my address, then (when paid) View on
  Arcscan. Status screens have no button; they refresh every 30 seconds.
- **R6 — the checklist is required.** Send my address stays disabled until all three boxes are
  ticked. A wrong address cannot be taken back from the link, and the boxes cost a few seconds.
- **R7 — never ask for secrets.** Each step says plainly that only the address is needed, and that
  Vestiarion never asks for a recovery phrase or private key.

## 4. Screens and microcopy

| Screen | Step | Heading | Body and guidance | Action |
|---|---|---|---|---|
| Add address | Step 1 of 3 | "{Business} wants to pay you {amount} USDC" | What it is for. How it works in three lines. Field "Your wallet address on {chain}", hint "Starts with 0x, then 40 letters and numbers. Copy it from your wallet, such as MetaMask." Footnote "No account or fee needed. This link expires on {date}." | **Continue** |
| Check address | Step 1 of 3 | "Check your address" | The address in groups of four. "Before you send it": "It's my own wallet, and I can open it." / "It's not an exchange deposit address." / "The first and last characters match my wallet." "After you send it, this link can't change it." | **Send my address** (secondary: Edit address) |
| Confirming | Step 2 of 3 | "Address sent. {Business} confirms it next." | "Waiting for {business} to confirm" with the masked address. Why a person checks. "Keep this link. It shows your payment's status until {date}." | none |
| Paying | Step 3 of 3 | "Your address is confirmed" | Each payment with its status: Being prepared, Scheduled for {date}, With {business} for review, On its way, Paid. | none |
| Paid | All done | "You've been paid {amount} USDC" | From, For, Amount, To, Network, Paid on, Transaction. "Not in your wallet yet?" help. | **View on Arcscan** |
| Invalid link | none | "This link is no longer valid. Ask the business that sent it for a new one." | unchanged | none |

Errors:

| Case | Message |
|---|---|
| Not an address | "That doesn't look like a wallet address. It starts with 0x and has 42 characters in all." |
| Already on file | "That is already the address {business} has on file." (unchanged) |
| Anything else | "That did not work. Try again in a moment." (unchanged) |

## 5. How

- **Migration 0053** adds `payee_link_status(p_token_hash)`: a definer function, service role only,
  returning one JSON object for a usable link or a link used within 30 days (R1, R2).
- **`payeeLinkStatus` and `payeeStage`** read it and decide the step and each payment's words.
  They are pure where they can be, and tested.
- **The page renders by stage.** The address form becomes two client steps (R6), and on success it
  refreshes into the confirming screen.
- **The email** says the link shows the payment's status afterwards.

## 6. Not in this PR

- An email to the freelancer when the payment is sent. The status page is the confirmation for now;
  the email needs the payee's address stored with the link.
- A choice of language. The app is in English.
