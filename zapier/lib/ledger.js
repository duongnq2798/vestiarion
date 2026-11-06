'use strict';

const { vestiarion } = require('./http');

/**
 * The ledger as the triggers read it (Zapier Z1, Z4): the newest entries first, one page, each with the fields a Zap
 * maps most, lifted out of `detail`.
 */

/** The ledger's domains, with the names a Zap shows. */
const DOMAIN_CHOICES = [
  { value: 'ap', label: 'Bills', sample: 'ap' },
  { value: 'ar', label: 'Receivables', sample: 'ar' },
  { value: 'contractor', label: 'Contractor milestones', sample: 'contractor' },
  { value: 'compliance', label: 'Screening and payees', sample: 'compliance' },
  { value: 'treasury', label: 'Treasury', sample: 'treasury' },
  { value: 'system', label: 'Workspace', sample: 'system' },
];

const ACTOR_CHOICES = [
  { value: 'agent', label: 'The agent', sample: 'agent' },
  { value: 'human', label: 'A person', sample: 'human' },
  { value: 'system', label: 'Vestiarion itself', sample: 'system' },
];

const object = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {});
const text = (value) => (typeof value === 'string' && value !== '' ? value : null);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** An entry with the fields a Zap maps most, read from its `detail`; the whole entry stays as it was signed. */
function withFields(entry) {
  const detail = object(entry.detail);
  const decision = object(detail.decision);
  const execution = object(detail.execution);
  const observed = object(detail.observed);
  return {
    ...entry,
    reasoning: text(decision.reasoning) || text(detail.reasoning),
    invoiceId: text(detail.invoiceId),
    milestoneId: text(detail.milestoneId),
    counterpartyId: text(detail.counterpartyId),
    amount: number(detail.amountPaid) ?? number(detail.amount) ?? number(observed.amount),
    currency: text(detail.currency),
    txRef: text(detail.txRef) || text(execution.txRef),
  };
}

/** The newest `limit` entries, newest first, with `domain` and `actor` when given (Zapier Z1). */
async function newestEntries(z, bundle, { limit, domain, actor }) {
  const params = { order: 'desc', limit: String(limit) };
  if (domain) params.domain = domain;
  if (actor) params.actor = actor;
  const answer = await vestiarion(z, bundle, { path: '/api/v1/ledger', params });
  const data = Array.isArray(answer && answer.data) ? answer.data : [];
  return data.map(withFields);
}

/** "ap_pay, ap_hold" as ["ap_pay", "ap_hold"]; empty for an empty field. */
function actionList(value) {
  return String(value || '')
    .split(',')
    .map((action) => action.trim())
    .filter(Boolean);
}

/** An entry as the samples show it, so a Zap can be mapped before anything happens. */
const SAMPLE_ENTRY = withFields({
  seq: 8590,
  id: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
  ts: '2026-11-06T09:14:02.511Z',
  actor: 'agent',
  domain: 'ap',
  action: 'ap_pay',
  summary: 'PAY invoice from Northwind Design for 120 USDC',
  detail: {
    invoiceId: '1ebe0cff-cd87-4d9f-a557-dccb394ff1ae',
    counterpartyId: 'bc56787e-f78a-416b-8ef3-0599fc60a875',
    currency: 'USDC',
    decision: {
      action: 'pay',
      reasoning: 'Northwind Design is screened clear, the goods were received and PO-1042 is on file, and the bill is due today.',
      confidence: 0.94,
    },
    observed: { amount: 120 },
    execution: { resultingStatus: 'paid', txRef: '0x9930cdb6a1f4e1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b' },
  },
  bodyHash: '4f2a',
  signature: 'MEUCIQ',
  prevHash: '9c1d',
  hash: '7e3b',
  signingKeyId: 'a1b2c3d4e5f60718',
});

/** The fields every ledger trigger outputs, with labels a Zap shows. */
const ENTRY_OUTPUT_FIELDS = [
  { key: 'id', label: 'Entry ID' },
  { key: 'seq', label: 'Seq', type: 'integer' },
  { key: 'ts', label: 'Time', type: 'datetime' },
  { key: 'actor', label: 'Actor' },
  { key: 'domain', label: 'Domain' },
  { key: 'action', label: 'Action' },
  { key: 'summary', label: 'Summary' },
  { key: 'reasoning', label: "Agent's reasoning" },
  { key: 'invoiceId', label: 'Bill ID' },
  { key: 'milestoneId', label: 'Milestone ID' },
  { key: 'counterpartyId', label: 'Counterparty ID' },
  { key: 'amount', label: 'Amount', type: 'number' },
  { key: 'currency', label: 'Currency' },
  { key: 'txRef', label: 'Transaction' },
];

module.exports = { ACTOR_CHOICES, DOMAIN_CHOICES, ENTRY_OUTPUT_FIELDS, SAMPLE_ENTRY, actionList, newestEntries, withFields };
