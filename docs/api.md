# Vestiarion read API

The read API is served under `/api/v1`. Every request requires the configured
agent token:

```http
Authorization: Bearer <AGENT_API_TOKEN>
```

Successes use `{ "data": ... }`. Collections also include a `page` object.
Errors use `{ "error": { "code": "...", "message": "..." } }`. All examples
below were captured from the running application on 25 September 2026. Large
history and telemetry arrays are explicitly marked as excerpts; every shown
row and value came from the response.

## Pagination

Collection parameters shared by `/ledger`, `/invoices`, `/counterparties`, and
`/milestones`:

| Parameter | Meaning |
| --- | --- |
| `limit` | Positive integer; defaults to 50 and is capped at 200. |
| `cursor` | Opaque value from the previous response's `page.nextCursor`. |

The server fetches `limit + 1` rows to determine `hasMore`. Do not decode or
construct cursors. Invoice, counterparty, and milestone collections are newest
first, with the row ID breaking equal timestamps. The ledger is ascending by
sequence because it is an append-only stream.

## `GET /api/v1/status`

No parameters. Reports safe configuration descriptors and operating modes;
secrets are never included.

```json
{"data":{"businessName":"Vestiarion workspace","provenance":{"payments":"live","yield":"simulate","screening":"simulate"},"clock":{"mode":"simulate","day":25,"lastCycleAt":"2026-09-24T18:33:04.546517+00:00"},"totals":{"decisionsLogged":77,"totalPaidOut":4.815,"flagged":1},"configuration":{"businessName":"Vestiarion workspace","database":{"host":"your-project.supabase.co"},"chain":{"circleConfigured":true,"arcRpcConfigured":false},"llm":{"pinned":null,"available":["deepseek"]},"compliance":{"mode":"bundled","rescreenIntervalHours":0},"followUp":{"staleAfterDays":3,"reEscalateAfterDays":7},"ledgerSigningKeyProvided":false,"githubTokenProvided":false,"clockMode":"simulate"},"apiVersion":"v1"}}
```

## `GET /api/v1/ledger`

Parameters: `limit`, `cursor`, plus optional free-text `domain` and `actor`
filters. Entries are returned oldest first.

```json
{"data":[{"seq":82,"id":"4566714f-a9f0-42c8-bcd4-d89adf830806","ts":"2026-09-24T11:55:00.370366+00:00","actor":"system","domain":"system","action":"seed","summary":"Seeded demo business: Northstar Studio","detail":{"accounts":3,"invoices":6,"milestones":3,"amountScale":0.001,"counterparties":7},"bodyHash":"8780d07cb3d083d359119e58fd4783f5e4b32aac14e0a8d9f7a5bb13365a4537","signature":"c14f06b751d31be6566ed11676d60d2db731ab8bbc5972f79d0a0c131e9e37200303d5b3ad04993b7973b1ce7200e7214e5a9b511306fa30538f072eb0d34705","prevHash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"b0ac72908868ddd5ed4722fd8a14ff4a844eee4dad382c5c85288bca73737669"}],"page":{"nextCursor":"eyJrIjo4Mn0","hasMore":true,"count":1}}
```

### Resuming from a ledger cursor

Persist `page.nextCursor` only after processing every entry in that response.
Pass it unchanged on the next request:

```text
GET /api/v1/ledger?limit=100
GET /api/v1/ledger?limit=100&cursor=<previous page.nextCursor>
```

Continue until `hasMore` is `false` and `nextCursor` is `null`. On the next
poll, reuse the last non-null cursor you successfully processed. Because the
ledger is append-only and ascending by its gap-free `seq`, that cursor is a
watermark: later entries are returned once, and earlier entries are not
replayed. A malformed cursor receives `400 invalid_request`; the API never
silently restarts from the beginning.

## `GET /api/v1/ledger/verify`

No parameters. Replays signatures, body hashes, and hash-chain continuity.

```json
{"data":{"valid":true,"checkedEntries":99}}
```

`valid` has three values, not two. `true` verified and `false` broken are
findings about the chain; **`null` means no verdict was produced** — the
deployment declares no ledger public key, so authorship was never checked. A
consumer that treats `null` as a failure will report a tampered audit trail
because an environment variable is missing. `reason` says which case it is, and
`brokenAt` is absent whenever `valid` is `null`.

```json
{"data":{"valid":null,"checkedEntries":99,"reason":"no ledger public key is configured, so authorship was not checked"}}
```

Set `LEDGER_PUBLIC_KEY` (the public half alone is enough) or `LEDGER_SIGNING_KEY`
to get a real verdict. `GET /api/v1/status` reports both as
`ledgerPublicKeyProvided` and `ledgerSigningKeyProvided`.

The compatibility route `GET /api/ledger/verify` remains available for the
Audit page and retains its legacy bare response:

```json
{"valid":true,"checkedEntries":99}
```

## `GET /api/v1/invoices`

| Parameter | Accepted values |
| --- | --- |
| `direction` | `payable`, `receivable` |
| `status` | `pending`, `matched`, `paid`, `held`, `flagged`, `awaiting_info`, `received`, `rejected` |
| `counterpartyId` | Counterparty UUID |
| `limit`, `cursor` | See pagination above. |

Only a `tx_ref` beginning with `0x` is exposed as `txHash`; simulated receipts
produce `null`.

```json
{"data":[{"id":"9440f32c-000d-4a63-97f1-4eb6bf78439f","direction":"payable","status":"paid","amount":0.11,"currency":"USDC","memo":"Stage-isolation verification","poReference":"PO-4001","goodsReceived":true,"dueDate":"2026-09-28T15:22:48.928+00:00","decidedAt":"2026-09-24T15:24:22.75+00:00","settledAt":"2026-09-24T15:24:22.75+00:00","escalatedAt":null,"agentReasoning":"Three-way match is complete: PO-4001 is on file and goodsReceived is true. Counterparty Vercel Inc has riskLevel 'clear' (not high) and the invoice amount 0.11 USDC is below the counterparty payment limit of 2 USDC. Treasury operatingBalance is 22.875 USDC, leaving 22.765 USDC after payment, and no duplicate matches were found (duplicateNote confirms no earlier payable from this counterparty resembles this invoice), so there is no fraud indicator.","txHash":"0xda97ba74aca6a45e4759858230e743aac0735252b874fb07c20ec8026d80a7bf","counterparty":{"id":"4e363b59-d1ca-4425-924c-5c894bc3373f","name":"Vercel Inc","riskLevel":"clear"},"createdAt":"2026-09-24T15:22:50.176754+00:00"}],"page":{"nextCursor":"eyJrIjoiMjAyNi0wOS0yNFQxNToyMjo1MC4xNzY3NTQrMDA6MDAiLCJpZCI6Ijk0NDBmMzJjLTAwMGQtNGE2My05N2YxLTRlYjZiZjc4NDM5ZiJ9","hasMore":true,"count":1}}
```

## `GET /api/v1/counterparties`

| Parameter | Accepted values |
| --- | --- |
| `role` | `vendor`, `client`, `contractor` |
| `riskLevel` | `unscreened`, `clear`, `medium`, `high` |
| `limit`, `cursor` | See pagination above. |

`performanceScore` is `null` when there is no history. Both the business
baseline and the risk-tier-derived current payment limit are reported.

```json
{"data":[{"id":"dc5e5751-3287-46c9-8bd1-83a42ab02699","name":"Anthropic API Services","role":"vendor","address":"0x90a5821e8a59b711777c49d11a283c9c76cd811e","chain":"ARC-TESTNET","jurisdiction":null,"riskLevel":"clear","riskNotes":"No match against watchlist","baselinePaymentLimit":5,"paymentLimit":5,"lastScreenedAt":"2026-09-24T18:32:57.327+00:00","performanceScore":0.667,"performanceInputs":{"heldOrFlagged":0,"heldByOurPolicy":1,"riskTierChanges":0,"duplicateSubmissions":0,"informationRequested":0,"paidWithoutIntervention":1},"createdAt":"2026-09-24T11:54:57.677284+00:00"}],"page":{"nextCursor":"eyJrIjoiMjAyNi0wOS0yNFQxMTo1NDo1Ny42NzcyODQrMDA6MDAiLCJpZCI6ImRjNWU1NzUxLTMyODctNDZjOS04YmQxLTgzYTQyYWIwMjY5OSJ9","hasMore":true,"count":1}}
```

## `GET /api/v1/counterparties/{id}`

Path parameter: counterparty UUID. An unknown ID returns `404 not_found`.
The response includes up to 20 recent checks, newest first. This captured
example is excerpted after the first history row.

```json
{"data":{"id":"dc5e5751-3287-46c9-8bd1-83a42ab02699","name":"Anthropic API Services","role":"vendor","address":"0x90a5821e8a59b711777c49d11a283c9c76cd811e","chain":"ARC-TESTNET","jurisdiction":null,"riskLevel":"clear","riskNotes":"No match against watchlist","baselinePaymentLimit":5,"paymentLimit":5,"lastScreenedAt":"2026-09-24T18:32:57.327+00:00","performanceScore":0.667,"performanceInputs":{"heldOrFlagged":0,"heldByOurPolicy":1,"riskTierChanges":0,"duplicateSubmissions":0,"informationRequested":0,"paidWithoutIntervention":1},"createdAt":"2026-09-24T11:54:57.677284+00:00","screeningHistory":[{"id":"d49b558b-199f-46d5-a43e-ae2af3ad9c49","riskLevel":"clear","source":"simulated-sanctions-list","notes":"No match against watchlist","rawScore":null,"matchedEntityId":null,"screeningMode":"simulate","status":"complete","createdAt":"2026-09-24T18:32:58.403732+00:00"}]}}
```

## `GET /api/v1/milestones`

| Parameter | Accepted values |
| --- | --- |
| `status` | `pending`, `verified`, `paid`, `held` |
| `contractorId` | Contractor counterparty UUID |
| `limit`, `cursor` | See pagination above. |

Only a real `0x` transaction is exposed as `txHash`.

```json
{"data":[{"id":"d01b2b49-2ca3-45fe-898c-f2c0128f6188","title":"Landing page redesign — milestone 2","amount":0.9,"status":"paid","verificationSource":"timesheet:kimai","verificationMethod":"seed","verificationStatus":"verified","verificationCheckedAt":null,"verifiedAt":"2026-09-24T11:54:57.14+00:00","verificationDetail":{"fixture":true},"verified":true,"decidedAt":"2026-09-24T11:55:54.276+00:00","settledAt":"2026-09-24T11:55:54.276+00:00","agentReasoning":"Milestone 'Landing page redesign — milestone 2' for 0.9 USDC is verified via timesheet:kimai, contractor Diego Ramirez has riskLevel 'clear' (not high), and the amount 0.9 is below his paymentLimit of 2.5. No duplicate invoice or PO mismatch indicated, and verification source is confirmed, so immediate release is justified rather than deferring to Net-30.","txHash":"0xa710040ac59af4501a4c91f70287f1fecec1aad037e5d0fc2141fe270f81d969","contractor":{"id":"5541f1a4-4e48-4fa5-880c-9ffc97d8953b","name":"Diego Ramirez — Design Contractor","riskLevel":"clear"},"createdAt":"2026-09-24T11:54:57.933771+00:00"}],"page":{"nextCursor":"eyJrIjoiMjAyNi0wOS0yNFQxMTo1NDo1Ny45MzM3NzErMDA6MDAiLCJpZCI6ImQwMWIyYjQ5LTJjYTMtNDVmZS04OThjLWYyYzAxMjhmNjE4OCJ9","hasMore":true,"count":1}}
```

## `GET /api/v1/treasury`

No parameters. Obligations are from the latest completed cycle snapshot. They
remain `null` before any snapshot exists; the API does not invent zeroes.

```json
{"data":{"accounts":[{"id":"55ce33e5-4b1c-47e6-838b-2446b80300c7","name":"Base Client Wallet","kind":"chain","chain":"BASE-SEPOLIA","token":"USDC","address":"0x4d10b4076a4975650e80d087fc9c99610ca76266","balance":0,"apy":0},{"id":"6f32681d-2f32-4db2-9841-c44f9be25965","name":"Arc Operating Wallet","kind":"operating","chain":"ARC-TESTNET","token":"USDC","address":"0x2fafdda3f973e8f993911f1c2196d5e72d51d71d","balance":22.765,"apy":0},{"id":"02a3c356-9571-4d5e-992a-5672dedba590","name":"USYC Reserve","kind":"reserve","chain":"ARC-TESTNET","token":"USYC","address":"0x8c99d5b1ee35e7d02887f5064a1b3f1a78a0ab66","balance":0,"apy":0.045}],"reservePosition":0,"obligations":{"asOf":"2026-09-24T18:33:03.344+00:00","dueWithin7Days":11.2,"dueWithin14Days":11.2},"latestForecast":{"id":"73400ece-0f38-4695-9bad-3816650b71fb","asOf":"2026-09-24T18:33:03.226+00:00","horizonDays":14,"projectedInflow":9,"projectedOutflow":11.2,"liquidBalance":22.765,"recommendation":"Liquidity healthy."},"recentActions":[]}}
```

## `GET /api/v1/insights`

No parameters. This is the unchanged `getInsightsData()` read model. In
particular, `referenceDisagreementCount: null` means the cycle predates the
comparison, and `status: "partial"` is not rewritten as completed or failed.
The captured response below is excerpted to representative real rows; the live
response contained additional transfer, run, snapshot, and screening rows.

```json
{"data":{"transfers":[{"id":"359e82e1-958d-4327-9174-e0b885eebe8f","targetType":"invoice","targetId":"1d7e1714-3f84-493e-a3ea-c984a2881100","txRef":"0x36ea71ac97cad3743f227860785207e6f25148251735569be0f6b16c73130343","feeUsd":0.003248,"feeSource":"chain_reported","settledInMs":5000,"chain":"ARC-TESTNET","providerMode":"live","executedAt":"2026-09-24T11:55:24.131+00:00","status":"confirmed"}],"runs":[{"id":"8cbcf6ca-2d58-43c9-9237-3000851e7046","startedAt":"2026-09-24T11:53:06.672+00:00","finishedAt":"2026-09-24T11:53:16.101+00:00","durationMs":9429,"decisionCount":1,"paidCount":0,"heldCount":0,"flaggedCount":0,"awaitingInfoCount":0,"releasedCount":0,"modelDecisionCount":1,"heuristicDecisionCount":0,"guardrailOverrideCount":0,"referenceDisagreementCount":null,"status":"completed","failedStage":null,"errorMessage":null,"chainMode":"live","screeningMode":"simulate"},{"id":"bd76f653-4352-42b3-aec5-5ddbbe01c882","startedAt":"2026-09-24T15:22:50.871+00:00","finishedAt":"2026-09-24T15:23:00.617+00:00","durationMs":9746,"decisionCount":0,"paidCount":0,"heldCount":0,"flaggedCount":0,"awaitingInfoCount":0,"releasedCount":0,"modelDecisionCount":0,"heuristicDecisionCount":0,"guardrailOverrideCount":0,"referenceDisagreementCount":0,"status":"partial","failedStage":"ap","errorMessage":"ap: AGENT_LLM_PROVIDER=openai but OPENAI_API_KEY is not set; treasury: AGENT_LLM_PROVIDER=openai but OPENAI_API_KEY is not set","chainMode":"live","screeningMode":"simulate"}],"snapshots":[{"id":"352d94e4-a945-420f-a933-34b06b46412b","cycleRunId":"8cbcf6ca-2d58-43c9-9237-3000851e7046","capturedAt":"2026-09-24T11:53:16.101+00:00","totalLiquid":27.58,"openPayables":10.695,"openReceivables":9,"obligationsDue7d":12.195,"obligationsDue14d":12.195,"reservePosition":0,"chainMode":"live"}],"treasuryMoves":[],"screenings":[{"id":"54d6f2a8-d939-45ef-a41e-61f88fd362ae","counterpartyId":"dc5e5751-3287-46c9-8bd1-83a42ab02699","counterpartyName":"Anthropic API Services","riskLevel":"clear","previousRiskLevel":null,"tierChanged":false,"mode":"simulate","source":"simulated-sanctions-list","status":"complete","createdAt":"2026-09-24T11:55:11.147351+00:00"}]}}
```

## Error codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid limit, cursor, or enumerated filter. The message lists accepted enum values. |
| 401 | `unauthorized` | Missing or invalid bearer token. |
| 403 | `forbidden` | The authenticated token lacks the required scope. Reserved for scoped-token deployments. |
| 404 | `not_found` | A requested singleton-by-ID resource does not exist. |
| 429 | `rate_limited` | Request quota exceeded; inspect `Retry-After`. |
| 503 | `unavailable` | A required upstream service is unavailable. |
| 500 | `internal` | Unexpected server error; implementation details are not exposed. |

Example invalid filter:

```json
{"error":{"code":"invalid_request","message":"riskLevel must be one of unscreened, clear, medium, high."}}
```
