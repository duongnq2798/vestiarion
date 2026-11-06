'use strict';

const { ACTOR_CHOICES, DOMAIN_CHOICES, ENTRY_OUTPUT_FIELDS, SAMPLE_ENTRY, actionList, newestEntries } = require('../lib/ledger');

/** New Ledger Entry (Zapier Z4): every signed entry, by the agent, a person or Vestiarion, with optional filters. */
module.exports = {
  key: 'ledger_entry',
  noun: 'Ledger Entry',
  display: {
    label: 'New Ledger Entry',
    description: 'Triggers when an entry is signed into the ledger, such as a bill added, a payee confirmed or a key created.',
  },
  operation: {
    type: 'polling',
    inputFields: [
      { key: 'domain', label: 'Domain', required: false, choices: DOMAIN_CHOICES, helpText: 'Only entries in this domain.' },
      { key: 'actor', label: 'Actor', required: false, choices: ACTOR_CHOICES, helpText: 'Only entries written by this actor.' },
      {
        key: 'actions',
        label: 'Actions',
        required: false,
        helpText: 'Only entries with one of these actions, separated by commas, such as `ap_hold, ap_flag_fraud`. Leave it empty for every action.',
      },
    ],
    perform: async (z, bundle) => {
      const entries = await newestEntries(z, bundle, { limit: 100, domain: bundle.inputData.domain, actor: bundle.inputData.actor });
      const actions = actionList(bundle.inputData.actions);
      return actions.length === 0 ? entries : entries.filter((entry) => actions.includes(entry.action));
    },
    sample: SAMPLE_ENTRY,
    outputFields: ENTRY_OUTPUT_FIELDS,
  },
};
