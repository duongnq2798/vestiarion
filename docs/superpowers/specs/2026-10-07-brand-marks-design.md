# Brand marks: the services Vestiarion is built on and works with

Date: 2026-10-07. Status: shipped with this branch.

## 1. Why

A visitor recognises Arc, Slack or Telegram faster by its mark than by its name, and a member connecting Slack or
Telegram in Settings finds the right card faster. The marks must not cost the product what it sells: every claim on the
public pages is checkable, so a mark may only stand for an integration the code has, and never for an endorsement.

## 2. Rulings

- **M1 — only real integrations.** Arc (payments settle there), Circle (its wallets carry them), Slack and Telegram (the
  agent asks and reports there), and npm (the SDK is published there). **Gmail has no mark:** the invoice inbox is reached by forwarding from any mailbox (Resend inbound), and there
  is no Gmail integration to stand for.
- **M2 — in words, beside a name.** "Built on", "Payments through", "Works with", "SDK on"; never "partners", "trusted
  by", "powered by". A mark is decoration (`aria-hidden`) beside its written name, never instead of it. npm's mark spells
  its name, so there the written name is for screen readers only.
- **M3 — the owner's file, unaltered.** Each mark is its owner's published file, served byte for byte from
  `public/brands/` in its own colours (`src/components/vx/BrandMarks.tsx`): no recolouring, cropping or redrawing, which
  the owners' guidelines forbid (Slack allows only its colours, or black or white; Circle its colours or Licorice; Arc's
  logo only unchanged). Arc's is its app icon, Circle's its colour symbol, Slack's its colour symbol (whose file keeps its
  clear space, so it is drawn larger and pulled in rather than cut), Telegram's its symbol, npm's its wordmark. The tests
  hold each file to its SHA-256. The site has no dark theme, so no mark needs a light variant.
- **M3a — the trademark notice.** The strip ends with "npm is a registered trademark of npm, Inc.", as npm's policy asks,
  and says the other marks are their owners' and not an endorsement.
- **M4 — each with its evidence.** On the landing page every service links to what proves it: `/open` for Arc, the live
  provider's code for Circle, the guides for Slack and Telegram, the SDK page for npm.

## 3. Where

- The landing page: "Built on, and works with", right under "Verifiable, not vouched for".
- Settings: the Slack section's heading and the Telegram card.
- `/open`: Arc's mark beside each network's name.
- The Slack and Telegram guides' screenshots, re-photographed (`npm run docs:screenshots -- slack-settings telegram-connect`).

## 4. Tests

`tests/brand-marks.test.tsx`: each the owner's file by its SHA-256, an empty alt and hidden from assistive technology,
never filtered or recoloured; exactly the five brands, no Gmail; no file
draws a mark without the brand's name; the landing strip's names, links, and wording. The Slack panel, Telegram card
and `/open` tests check the mark beside each name.

## 5. Changes

- **2026-10-07.** Circle's mark added, from the monochrome symbol Circle publishes; it was its name alone before.
- **2026-10-07.** One-ink marks replaced by the owners' own files in their colours, after reading the owners'
  guidelines: Slack forbids recolouring beyond black or white, Circle names its colours, and Arc's logo is used unchanged,
  so the traced Arc symbol gave way to Arc's app icon. The npm trademark notice was added.
