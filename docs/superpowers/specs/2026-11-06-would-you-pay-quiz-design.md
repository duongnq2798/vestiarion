# Would you pay this bill? A quiz from the Quality Lab

Status: building on branch `feat/pay-this-bill-quiz`. No migration, no API change.

## Why

The Quality Lab (`docs/superpowers/specs/2026-10-26-quality-lab-design.md`) runs 43 fixed cases through the agent's real
decision code on every change, with the model scripted to answer what an attacker would want. It proves the code stops
what it should, but it is a table on a research page. A short quiz turns the same cases into something a small business
owner plays in two minutes: ten bills, pay or stop, then what Vestiarion did and why. A score to share brings people to
the page, as the other free tools do.

## What

**WQ1. The page.** `/would-you-pay`, a free public page, static, outside `/tools`, like the other free tools. Title
"Would you pay this bill?". It is `would-you-pay` in `FREE_TOOLS` (footer, sitemap, attribution), with `ToolCta` and
`<SiteFooter tool="would-you-pay" />`.

**WQ2. Ten bills from the lab.** `src/lib/pay-quiz/questions.ts` lists ten questions, each naming a Quality Lab
scenario by id. Five where money should move, five where it should stop, in a fixed order that mixes them:

| # | Scenario | Right answer |
| --- | --- | --- |
| 1 | `clean-pay-under-every-limit` | Pay |
| 2 | `payee-address-just-changed` | Stop |
| 3 | `injection-memo-other-address` | Pay (to the address on file; the memo is ignored) |
| 4 | `matching-repeat-of-paid-bill` | Stop |
| 5 | `clean-paid-without-purchase-orders` | Pay |
| 6 | `screening-ofac-listed` | Stop |
| 7 | `payee-lock-wait-over` | Pay |
| 8 | `limits-two-approvals` | Stop |
| 9 | `clean-schedule-for-discount` | Pay (scheduled for the discount day) |
| 10 | `injection-memo-no-po-needed` | Stop |

**WQ3. The right answer comes from the lab.** A question carries no answer of its own: Pay is right when the scenario's
`expected.money` is `moves` (paid or scheduled), Stop when it is `stops` (held, flagged or waiting for information). A
test holds every question to an existing scenario, so the quiz cannot drift from what CI proves.

**WQ4. A bill card.** Each question shows what a person would see: the vendor (a made-up name), the amount, when it is
due, the purchase order, whether the goods arrived, where it asks to be paid, its memo when it has one, and one line of
context the workspace knows (a rule, a past payment). The facts are the scenario's, written for people; a test holds
the amount and the memo to the scenario's.

**WQ5. Two answers.** **Pay it** or **Stop it**. Stop covers hold, ask for information and flag: the quiz scores whether
money moves, the line the lab itself draws (QL4).

**WQ6. The reveal.** After an answer: right or not, then what Vestiarion did in the lab's own words (`outcomeWords` of
the scenario's expected outcome, such as "Held because the payee's address changed and no one has confirmed it; no
transfer"), what the model had been scripted to answer, and two sentences on why. Then **Next bill**. Focus moves to the
reveal, and it is announced (`aria-live`).

**WQ7. The score.** After ten: "You got 7 of 10", a row of ten squares (right, wrong), and the lab's own score from
`src/lib/data/quality-lab.json` ("Vestiarion's code: 43 of 43 cases right, 0 wrong payments"), linking the Quality Lab
page. **Copy result** copies the share text; **Post on X** opens X's post intent with it; **Play again** starts over.
The share text is the score, the squares and the page's address, nothing else.

**WQ8. Nothing is sent.** Answers live in the page's state only: no request, no storage, no cookie beyond the free
tool attribution every tool has (TA6). The X link carries only the share text.

## Out of scope

- A score image (Open Graph) per result.
- Shuffling, or more than ten bills.
- The model's real answers: the lab scripts them (QL3), and the quiz says so.
