# Early payment in the agent's activity (design)

Builds on [agent activity](2026-10-03-agent-activity-design.md) and the early-payment offers specs of Oct 16-17. The
activity feed is what the console's toasts, the Telegram chats and the Slack channel tell.

## Requirements

- **A1 What is told.** The feed now tells these early-payment entries, as they happen (`EARLY_PAYMENT_ACTIONS`):
  - the agent's `early_payment_offered` (`via: "agent"`): the discount, what the supplier receives today instead of the
    amount, and who decided it;
  - a supplier's `early_payment_offer_accepted` and `early_payment_offer_countered`;
  - the agent's `early_payment_counter_accepted` and `early_payment_counter_declined`. When code declined without a
    model, it says "Code declined it, without asking a model:" and code's reason;
  - an `early_payment_offer_withdrawn` the agent made: the cash no longer covers it, or its email never went.

  A person's own offer or withdrawal, and an `early_payment_offer_skipped`, are not told.
- **A2 Who records it.** The feed reads the agent's entries, plus the two answers a supplier gives, which the system
  records (`SUPPLIER_ANSWERS`). It reads them with
  `or=(actor.eq.agent,and(actor.eq.system,action.in.(...)))`. No other system entry is read.
- **A3 Not a decision for a person.** Each item is `done`, or `pending` for a counter the agent is about to answer.
  None is `stopped`, so no chat draws a card for it. Each links to the bill's card at how it was decided.
- **A4 Nothing else changes.** There is no migration, and nothing changes in `/api/v1` or the webhooks.
