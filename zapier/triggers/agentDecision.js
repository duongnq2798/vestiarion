'use strict';

const { DOMAIN_CHOICES, ENTRY_OUTPUT_FIELDS, SAMPLE_ENTRY, newestEntries } = require('../lib/ledger');

/** New Agent Decision (Zapier Z4): each entry the agent signs, newest first, with its reasoning. */
module.exports = {
  key: 'agent_decision',
  noun: 'Decision',
  display: {
    label: 'New Agent Decision',
    description: 'Triggers when the agent signs a decision: what it paid, held, flagged or scheduled, and why.',
  },
  operation: {
    type: 'polling',
    inputFields: [
      {
        key: 'domain',
        label: 'Domain',
        required: false,
        choices: DOMAIN_CHOICES,
        helpText: 'Only decisions in this domain, such as Bills. Leave it empty for every decision.',
      },
    ],
    perform: (z, bundle) => newestEntries(z, bundle, { limit: 100, domain: bundle.inputData.domain, actor: 'agent' }),
    sample: SAMPLE_ENTRY,
    outputFields: ENTRY_OUTPUT_FIELDS,
  },
};
