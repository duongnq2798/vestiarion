# Landing review: which rule decides, a shorter proof, and how long it takes to start

A review of the whole landing page, read on the live site. This change takes the first of its three priorities, part of
the second and part of the third. The other sections are noted under "Left for their own change".

## What the review found, and what changed

- **"The written policy disagreed; code checks passed" on a paid bill read as a rule broken.** The page says "The AI
  suggests. Your rules decide." A reader then took a paid bill the policy disagreed with for the agent going against the
  rules.
  - In fact the written policy is a second answer to the same facts. It is kept beside the model's only to compare, and
    never pays or blocks. The rules that decide are the checks in code.
  - The proof now leads with the rules in code and says what the policy is for:
    - a paid row reads "Rules in code passed it. The written policy, kept only to compare, would have decided
      otherwise." (or "The written policy agreed.");
    - the latest decision's badges read "Rules in code: Passed", then "Written policy, to compare: Agreed" or
      "Differed". "Differed" is neutral, not the held amber;
    - one sentence under the badges says it plainly: "Rules in code decide, and can refuse what any model proposes. The
      written policy is a second answer to the same facts, kept beside the model's to compare: it never pays or
      blocks."
  - The badges and sentences say "rules in code", not "your rules". Some refusals come from limits in Vestiarion's
    code, such as a cross-chain fee cap, and not from a limit the workspace set.
  - The research note's links read "When the model and the written policy disagree", its own subject, in place of "the
    rules disagreed".
- **The proof was long.** Earlier decisions list three, not five. When none of the newest three was refused by code but
  an older one read was, the newest refusal takes the last place, so the list shows the rules in code stopping a
  payment, not only payments going out. The page reads up to twelve decisions to find one; the database function
  already allows twelve. Its loading placeholder is measured again for the shorter list.
- **The FAQ did not say how long it takes to start.** It now asks "How long does it take to start?" second. The answer
  matches the docs' first steps: about five minutes; the agent usually decides on a bill within a minute; Xero or
  HubSpot take a few clicks more. QuickBooks Online is left out of that line, since the hosted service connects to
  sandbox companies only.

## Not taken

- **Moving Invoice Capture out of the hero.** It was put there in an earlier round, on purpose, as a small secondary
  line shown on a computer only.
- **Shrinking Arc and Circle to a strip.** An earlier review asked for them to stand out as what Vestiarion is built on.

## Waiting on a decision

- **What it costs.** The FAQ still leaves cost out: there is no published price. A free trial or a price is the
  partner's to state.

## Left for their own change

- **Integrations:** a logo and one line per tool, a few shown, the rest behind a link.
- **Safety:** lead with setting limits, approving exceptions and pausing the agent, with the technical blocks folded.
- **How it works:** trying it apart from turning on payments, with less text per card.
- **The closing call to action:** one line in place of four steps.
- **The developers' heading.**
- **The footer:** a quieter Product Hunt badge, and a contact channel that is not GitHub Issues.

## Checked

- Tests:
  - `tests/latest-decision.test.ts` and `tests/recent-decisions.test.ts`: the rules in code first, "Differed" neutral,
    the sentences, and the newest refusal taking the last place.
  - `tests/landing-recent-decisions.test.tsx`: the one sentence on which decides.
  - `tests/landing-faq.test.tsx`: the new question and its place.
- Headless Edge, against production's decisions, at 1440, 768 and 375 px. The latest decision with three earlier ones,
  a refusal by code among them, measures 44.5, 60.8 and 87.8 rem.
