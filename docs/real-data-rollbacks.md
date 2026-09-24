# Real-data rollout rollback notes

These steps are deliberately manual: rollback is an incident decision, not a button exposed to the app.

## Phase 1 — public access and agent controls

Application rollback: revert the Phase 1 commit and redeploy. This restores the old unprotected handlers, so it is suitable only for an isolated demo environment. Rotate `AGENT_API_TOKEN` after any suspected disclosure.

Database rollback: the safe default is to keep the new deny-by-default grants and policies. If an isolated demo must regain direct anonymous reads, restore only `select` on the nine original tables and recreate their `<table>_public_read` policies. Do not restore anonymous writes or function execution. The server-side service-role dashboard continues to operate without this rollback.

Reset recovery: `seedDatabase` deletes business rows before inserting fixtures. Restore a database backup if reset was invoked against valuable data; there is intentionally no automatic undo.

## Phase 2 — payment intents and reconciliation

Application rollback: stop all cycle runners first, then revert the Phase 2 commit. Do not drop `payment_intents` until every `submitting` or `pending` row has been reconciled with Circle; otherwise the durable duplicate-payment guard is lost.

Database rollback after reconciliation: retain the table as an audit record if possible. If removal is required, revoke and drop `claim_payment_intent(text)`, then drop `payment_intents`. Existing invoice and milestone settlement fields remain compatible with the earlier application.

## Phase 3 — OpenSanctions screening

Application rollback: unset `OPENSANCTIONS_API_URL` to return immediately to the labelled bundled provider, or revert the Phase 3 commit. Existing live verdicts and their tiered limits remain until the bundled provider screens them again; review high-risk rows before changing providers.

Database rollback: the added evidence columns are backward-compatible and should normally remain. Dropping them discards raw match scores, matched entity ids, and explicit failed-check records, so export `compliance_checks` first if removal is unavoidable.

## Phase 4 — operator intake

Application rollback: revert the Phase 4 commit to remove the intake forms and Server Actions. Records already created remain valid business data; do not delete them as part of an application rollback. The external, bearer-protected emergency reset API remains separate from normal product navigation.

Data recovery: creation and CSV import are append operations, and each accepted row has a human ledger entry containing its id. If a bad import must be reversed, identify its exact invoice ids from `import_invoice` entries, export those rows, and delete only those ids during a controlled maintenance window. Ledger entries remain as the immutable record of both the original action and the correction.

## Phase 5 — verification and wall clock

Application rollback: disable `.github/workflows/agent-cycle.yml` first so an older deployment is not triggered unexpectedly, then revert the Phase 5 commit. Existing verification provenance columns are backward-compatible and should remain for audit history.

Operational rollback: unset `GITHUB_TOKEN` to stop remote verification; the app will label checks unavailable and retain previous verdicts. Set `CYCLE_CLOCK_MODE=simulate` only for a disposable demo. Returning a production deployment to the numbered clock does not change real invoice due dates, which always use wall-clock timestamps.

Database rollback: export milestone verification details before dropping any Phase 5 columns. Never rewrite or remove the human/system ledger entries that recorded the original verification decisions.
