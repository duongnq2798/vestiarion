'use strict';

const { vestiarion } = require('../lib/http');

/**
 * The workspace's vendors and contractors, for Create Bill's Counterparty dropdown (Zapier Z5). Hidden: no Zap starts
 * on it.
 */
module.exports = {
  key: 'counterparty_list',
  noun: 'Counterparty',
  display: {
    label: 'Counterparties',
    description: "Lists the workspace's vendors and contractors for a dropdown.",
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform: async (z, bundle) => {
      // The most one page holds: a workspace with more maps a counterparty ID instead.
      const answer = await vestiarion(z, bundle, { path: '/api/v1/counterparties', params: { limit: '200' } });
      const data = Array.isArray(answer && answer.data) ? answer.data : [];
      // A bill is from a vendor or a contractor; a client is owed, not paid.
      return data
        .filter((counterparty) => counterparty.role === 'vendor' || counterparty.role === 'contractor')
        .map((counterparty) => ({ ...counterparty, label: `${counterparty.name} (${counterparty.role})` }));
    },
    sample: { id: 'dc5e5751-3287-46c9-8bd1-83a42ab02699', name: 'Northwind Design', role: 'vendor', riskLevel: 'clear', label: 'Northwind Design (vendor)' },
    outputFields: [
      { key: 'id', label: 'Counterparty ID' },
      { key: 'name', label: 'Name' },
      { key: 'role', label: 'Role' },
      { key: 'riskLevel', label: 'Risk level' },
    ],
  },
};
