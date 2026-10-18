# Every page a counterparty opens says who sent it

Date: 2026-10-19. Status: built. Branch `feat/counterparty-loop`. No migration.

## Why

Every business on Vestiarion sends its suppliers, payees and customers pages and emails: a supplier's payment status, a
payee's address link, a receipt, an early-payment offer, a request for more time, a pay link, a statement. Each of those
people runs a business with bills of its own, and each has just seen the agent work for someone else. Today nothing on
those pages says what sent them, and nothing would tell us if one of them came to look. Self-serve signups stalled
(activation funnel, Oct 9), and the people a business already pays are the warmest audience we have.

## The rules (decided here)

- **C1. Where.**
  - The nine public pages a business sends its counterparties: supplier payment status, payee link, receipt,
    early-payment offer, customer discount, request for more time, pay link, customer statement and shared report.
  - The emails sent to counterparties: payment notice, payee link, address request, early-payment offer and its
    answers, request for more time and its answers, customer discount and receivable reminder.
  - Never on a page inside a workspace or in an email to a member.
- **C2. What it says.**
  - On a page, one line at its foot, above the footer: "Sent with Vestiarion, the AI agent for bills and payments." and
    **Try it on your own bills**, which opens the landing page in a new tab, so a payee entering an address or a
    customer paying keeps the page they were on.
  - In an email, the footer: "Vestiarion · The AI agent for bills and payments, settled in USDC on Arc." and, below it,
    "Run your own bills with it: vestiarion.xyz", linked.
  - The link is in the HTML footer; an email's plain-text part is unchanged.
  - Member emails keep the footer's first line only. Its words follow the positioning of Oct 15: no longer "an
    autonomous treasury agent".
- **C3. Tagged, and nothing more.**
  - The link carries `utm_source` (the kind of page or email: `supplier_status`, `payee_link`, `receipt`, `early_offer`,
    `customer_discount`, `more_time`, `pay_link`, `statement`, `shared_report`, `payment_notice`, `address_request`,
    `term_request`, `receivable_reminder`).
  - It also carries `utm_medium` (`counterparty_page` or `counterparty_email`) and
    `utm_campaign=counterparty_loop`.
  - Never a workspace, a token, a person, an amount or anything else of the page: the tags name the kind of page only.
  - The landing page's first-touch cookie keeps them as it keeps any campaign's (migration 0099), and a workspace opened
    from it shows that source in /admin/growth.
  - The page's own address holds its token, so the link sends no referrer (`noopener noreferrer`): the tags alone say
    where the visit came from. Its analytics click is `loop-` and the kind, in hyphens.
- **C4. Counted.** /admin/growth counts the workspaces opened from the loop in its window, beside the other tiles.
- **C5. Said.** The privacy page says these pages and emails link to Vestiarion with tags that name the kind of page
  only, and the guides for each page say what its counterparty sees at its foot.

## What it does not do

- Change what any page or email does, or add a tracking pixel: the only signal is a person choosing the link.
- Let a business turn the line off: there is no setting yet.
