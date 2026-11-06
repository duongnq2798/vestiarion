'use strict';

const { version } = require('./package.json');
const { version: platformVersion } = require('zapier-platform-core');
const authentication = require('./authentication');
const { addApiKey, handleErrors } = require('./lib/http');
const agentDecision = require('./triggers/agentDecision');
const billPaid = require('./triggers/billPaid');
const ledgerEntry = require('./triggers/ledgerEntry');
const counterpartyList = require('./triggers/counterpartyList');
const createBill = require('./creates/createBill');

/**
 * Vestiarion in Zapier (docs/superpowers/specs/2026-11-06-zapier-integration-design.md): three polling triggers on
 * the ledger, a hidden one for the counterparty dropdown, and Create Bill, with a workspace API key.
 */
module.exports = {
  version,
  platformVersion,
  // Input reaches perform as typed or mapped; each step reads and trims what it needs.
  flags: { cleanInputData: false },
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [handleErrors],
  triggers: {
    [agentDecision.key]: agentDecision,
    [billPaid.key]: billPaid,
    [ledgerEntry.key]: ledgerEntry,
    [counterpartyList.key]: counterpartyList,
  },
  creates: {
    [createBill.key]: createBill,
  },
  searches: {},
  resources: {},
};
