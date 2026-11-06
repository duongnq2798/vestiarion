'use strict';

const { ENTRY_OUTPUT_FIELDS, SAMPLE_ENTRY, newestEntries } = require('../lib/ledger');

/**
 * Bill Paid (Zapier Z4): a bill's payment, by the agent on its own (`ap_pay` that ended `paid`) or by a person's
 * approval (`approval_paid` with status `paid`). A decision that ended held, or a transfer still waiting, is not one.
 */

function paidBy(entry) {
  const detail = entry.detail || {};
  if (entry.action === 'ap_pay' && detail.execution && detail.execution.resultingStatus === 'paid') return 'agent';
  if (entry.action === 'approval_paid' && detail.status === 'paid') return 'human';
  return null;
}

module.exports = {
  key: 'bill_paid',
  noun: 'Payment',
  display: {
    label: 'Bill Paid',
    description: 'Triggers when a bill is paid, by the agent on its own or once a person approves it.',
  },
  operation: {
    type: 'polling',
    perform: async (z, bundle) => {
      const entries = await newestEntries(z, bundle, { limit: 200, domain: 'ap' });
      return entries.flatMap((entry) => {
        const by = paidBy(entry);
        return by ? [{ ...entry, paidBy: by }] : [];
      });
    },
    sample: { ...SAMPLE_ENTRY, paidBy: 'agent' },
    outputFields: [...ENTRY_OUTPUT_FIELDS, { key: 'paidBy', label: 'Paid by (agent or human)' }],
  },
};
