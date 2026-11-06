'use strict';

const { dayOf } = require('../lib/dates');
const { vestiarion } = require('../lib/http');

/**
 * Create Bill (Zapier Z5): adds a payable for the agent to decide, as one typed into the console, with every
 * guardrail. It never approves or pays: no key can.
 */

const filled = (value) => (value == null ? '' : String(value).trim());

async function perform(z, bundle) {
  const input = bundle.inputData;
  const counterpartyId = filled(input.counterpartyId);
  const amount = filled(input.amount);
  const dueDate = dayOf(input.dueDate);
  if (counterpartyId === '') throw new z.errors.Error('Choose the counterparty the bill is from.', 'InvalidInput', 400);
  if (amount === '') throw new z.errors.Error("Give the bill's amount, such as 1250.50.", 'InvalidInput', 400);
  if (!dueDate) throw new z.errors.Error(`Give the bill's due date as a date, such as 2026-11-30. The field holds "${filled(input.dueDate).slice(0, 40)}".`, 'InvalidInput', 400);

  // Not set is USDC. Anything else goes as given, so the API's 400 names a wrong one rather than a USDC bill.
  const body = { direction: 'payable', counterpartyId, amount, currency: filled(input.currency) || 'USDC', dueDate };
  if (filled(input.poReference)) body.poReference = filled(input.poReference);
  if (filled(input.memo)) body.memo = filled(input.memo);
  if (input.goodsReceived !== undefined && input.goodsReceived !== null && filled(input.goodsReceived) !== '') {
    body.goodsReceived = input.goodsReceived === true || filled(input.goodsReceived).toLowerCase() === 'true';
  }
  const percent = filled(input.discountPercent);
  const deadline = dayOf(input.discountDeadline);
  if ((percent === '') !== (deadline === null)) {
    throw new z.errors.Error('An early-payment discount needs both its percent and its deadline.', 'InvalidInput', 400);
  }
  if (percent !== '' && deadline) body.earlyPayDiscount = { percent, deadline };

  const key = filled(input.idempotencyKey);
  const answer = await vestiarion(z, bundle, {
    method: 'POST',
    path: '/api/v1/invoices',
    body,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  });
  return (answer && answer.data) || {};
}

module.exports = {
  key: 'create_bill',
  noun: 'Bill',
  display: {
    label: 'Create Bill',
    description: 'Adds a bill for the agent to decide, with every guardrail. It never approves or pays it.',
  },
  operation: {
    inputFields: [
      {
        key: 'counterpartyId',
        label: 'Counterparty',
        required: true,
        dynamic: 'counterparty_list.id.label',
        helpText: 'The vendor or contractor the bill is from. Pick one, or map a counterparty ID.',
      },
      { key: 'amount', label: 'Amount', required: true, helpText: 'What the bill asks for, such as `1250.50`, with at most 6 decimal places.' },
      { key: 'dueDate', label: 'Due Date', type: 'datetime', required: true, helpText: 'The day it is due. Only the day is sent.' },
      { key: 'currency', label: 'Currency', required: false, choices: { USDC: 'USDC', EURC: 'EURC' }, default: 'USDC' },
      { key: 'poReference', label: 'PO Reference', required: false, helpText: 'The purchase order it bills against. Without it, the agent asks for it instead of paying.' },
      {
        key: 'goodsReceived',
        label: 'Goods Received',
        type: 'boolean',
        required: false,
        helpText: 'Whether what it bills for has arrived. Without it, the agent asks before paying.',
      },
      { key: 'memo', label: 'Memo', required: false, helpText: 'What it is for, up to 280 characters.' },
      { key: 'discountPercent', label: 'Early-Payment Discount (Percent)', required: false, helpText: 'Such as `2`. Give its deadline too.' },
      { key: 'discountDeadline', label: 'Early-Payment Discount Deadline', type: 'datetime', required: false, helpText: 'The last day the discount applies, on or before the due date.' },
      {
        key: 'idempotencyKey',
        label: 'Idempotency Key',
        required: false,
        helpText: "Map something unique to the bill, such as the email's ID, so a replayed Zap adds it once: a repeat within 24 hours gets the first answer back.",
      },
    ],
    perform,
    sample: {
      id: '1ebe0cff-cd87-4d9f-a557-dccb394ff1ae',
      direction: 'payable',
      counterpartyId: 'dc5e5751-3287-46c9-8bd1-83a42ab02699',
      amount: 120,
      currency: 'USDC',
      dueDate: '2026-11-30',
      status: 'pending',
      poReference: 'PO-1042',
      goodsReceived: true,
      memo: 'November design work',
      createdAt: '2026-11-06T09:14:02.511Z',
    },
    outputFields: [
      { key: 'id', label: 'Bill ID' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'currency', label: 'Currency' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'counterpartyId', label: 'Counterparty ID' },
    ],
  },
};

