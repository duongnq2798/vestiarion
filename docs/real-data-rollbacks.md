# Real-data rollout rollback notes

These steps are deliberately manual: rollback is an incident decision, not a button exposed to the app.

## Phase 1 — public access and agent controls

Application rollback: revert the Phase 1 commit and redeploy. This restores the old unprotected handlers, so it is suitable only for an isolated demo environment. Rotate `AGENT_API_TOKEN` after any suspected disclosure.

Database rollback: the safe default is to keep the new deny-by-default grants and policies. If an isolated demo must regain direct anonymous reads, restore only `select` on the nine original tables and recreate their `<table>_public_read` policies. Do not restore anonymous writes or function execution. The server-side service-role dashboard continues to operate without this rollback.

Reset recovery: `seedDatabase` deletes business rows before inserting fixtures. Restore a database backup if reset was invoked against valuable data; there is intentionally no automatic undo.

## Phase 2 — payment intents and reconciliation

Application rollback: stop all cycle runners first, then revert the Phase 2 commit. Do not drop `payment_intents` until every `submitting` or `pending` row has been reconciled with Circle; otherwise the durable duplicate-payment guard is lost.

Database rollback after reconciliation: retain the table as an audit record if possible. If removal is required, revoke and drop `claim_payment_intent(text)`, then drop `payment_intents`. Existing invoice and milestone settlement fields remain compatible with the earlier application.
