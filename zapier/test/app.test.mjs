import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nock from 'nock';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// The integration is CommonJS, as Zapier runs it; the tests are a module, as vitest asks.
const require = createRequire(import.meta.url);
const zapier = require('zapier-platform-core');
const App = require('../index');
const { dayOf } = require('../lib/dates');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The Zapier integration (docs/superpowers/specs/2026-11-06-zapier-integration-design.md Z3-Z7), run through Zapier's
 * own app tester against a stubbed API: what each step asks for, what it keeps, and what it says when the API refuses.
 */

const appTester = zapier.createAppTester(App);
const API = 'https://www.vestiarion.xyz';
const KEY = 'vx_test_0000000000000000000000000000';
const authData = { apiKey: KEY, baseUrl: '' };

beforeAll(() => {
  zapier.tools.env.inject();
  nock.disableNetConnect();
});

afterEach(() => {
  expect(nock.pendingMocks(), 'every stubbed request was made').toEqual([]);
  nock.cleanAll();
});

const entry = (seq, fields) => ({
  seq,
  id: `entry-${seq}`,
  ts: '2026-11-06T09:00:00.000Z',
  actor: 'agent',
  domain: 'ap',
  action: 'ap_hold',
  summary: `entry ${seq}`,
  detail: {},
  bodyHash: 'b',
  signature: 's',
  prevHash: 'p',
  hash: 'h',
  signingKeyId: null,
  ...fields,
});
const page = (data) => ({ data, page: { nextCursor: null, hasMore: false, count: data.length } });

describe('authentication (Zapier Z3)', () => {
  it('tests the key against the status, as a bearer token, and labels the connection with the workspace', async () => {
    nock(API, { reqheaders: { authorization: `Bearer ${KEY}` } })
      .get('/api/v1/status')
      .reply(200, { data: { businessName: 'Pinecrest Studio', apiVersion: 'v1' } });
    const answer = await appTester(App.authentication.test, { authData });
    expect(answer.data.businessName).toBe('Pinecrest Studio');
    expect(App.authentication.connectionLabel({}, { inputData: answer })).toBe('Pinecrest Studio');
  });

  it('uses the Base URL given, without a trailing slash, and refuses plain http except to this machine', async () => {
    nock('https://vx.example.com').get('/api/v1/status').reply(200, { data: { businessName: 'Own deployment' } });
    await appTester(App.authentication.test, { authData: { apiKey: KEY, baseUrl: 'https://vx.example.com/' } });
    nock('http://localhost:3000').get('/api/v1/status').reply(200, { data: { businessName: 'Local' } });
    await appTester(App.authentication.test, { authData: { apiKey: KEY, baseUrl: 'http://localhost:3000' } });
    await expect(appTester(App.authentication.test, { authData: { apiKey: KEY, baseUrl: 'http://vx.example.com' } })).rejects.toThrow(
      'must be https, so the API key is never sent in the clear',
    );
    await expect(appTester(App.authentication.test, { authData: { apiKey: KEY, baseUrl: 'not a url' } })).rejects.toThrow('is not a URL');
  });

  it("asks to reconnect on a 401, keeps the API's message on any other error, and throttles a 429", async () => {
    nock(API).get('/api/v1/status').reply(401, { error: { code: 'unauthorized', message: 'The API key was revoked.' } });
    await expect(appTester(App.authentication.test, { authData })).rejects.toMatchObject({
      name: 'RefreshAuthError',
      message: expect.stringContaining('The API key was revoked. Reconnect Vestiarion'),
    });
    nock(API).get('/api/v1/status').reply(403, { error: { code: 'forbidden', message: 'This key cannot add records.' } });
    await expect(appTester(App.authentication.test, { authData })).rejects.toThrow('This key cannot add records.');
    nock(API).get('/api/v1/status').reply(429, { error: { code: 'rate_limited', message: 'Too many requests.' } }, { 'Retry-After': '12' });
    await expect(appTester(App.authentication.test, { authData })).rejects.toMatchObject({ name: 'ThrottledError' });
  });
});

describe('the triggers (Zapier Z1, Z4)', () => {
  it('New Agent Decision reads the newest decisions first, with a domain when chosen, and lifts the reasoning out', async () => {
    nock(API)
      .get('/api/v1/ledger')
      .query({ order: 'desc', limit: '100', actor: 'agent', domain: 'ap' })
      .reply(
        200,
        page([
          entry(12, {
            action: 'ap_pay',
            detail: {
              invoiceId: 'inv-1',
              counterpartyId: 'cp-1',
              currency: 'USDC',
              decision: { reasoning: 'Screened clear, matched, due today.' },
              observed: { amount: 0.2 },
              execution: { resultingStatus: 'paid', txRef: '0xabc' },
            },
          }),
          entry(11),
        ]),
      );
    const results = await appTester(App.triggers.agent_decision.operation.perform, { authData, inputData: { domain: 'ap' } });
    expect(results.map((result) => result.id)).toEqual(['entry-12', 'entry-11']);
    expect(results[0]).toMatchObject({ reasoning: 'Screened clear, matched, due today.', invoiceId: 'inv-1', counterpartyId: 'cp-1', amount: 0.2, currency: 'USDC', txRef: '0xabc' });
    expect(results[1]).toMatchObject({ reasoning: null, invoiceId: null, amount: null, txRef: null });
  });

  it('New Agent Decision reads every domain when none is chosen', async () => {
    nock(API).get('/api/v1/ledger').query({ order: 'desc', limit: '100', actor: 'agent' }).reply(200, page([]));
    expect(await appTester(App.triggers.agent_decision.operation.perform, { authData, inputData: {} })).toEqual([]);
  });

  it("Bill Paid keeps the agent's payments that ended paid and a person's approvals that paid, and nothing else", async () => {
    nock(API)
      .get('/api/v1/ledger')
      .query({ order: 'desc', limit: '200', domain: 'ap' })
      .reply(
        200,
        page([
          entry(20, { action: 'ap_pay', detail: { execution: { resultingStatus: 'paid', txRef: '0x1' } } }),
          entry(19, { action: 'ap_pay', detail: { execution: { resultingStatus: 'held' } } }),
          entry(18, { action: 'approval_paid', actor: 'human', detail: { status: 'paid', txRef: '0x2', amountPaid: 12.5, amount: 12.5 } }),
          entry(17, { action: 'approval_paid', actor: 'human', detail: { status: 'matched' } }),
          entry(16, { action: 'create_invoice', actor: 'human' }),
        ]),
      );
    const results = await appTester(App.triggers.bill_paid.operation.perform, { authData, inputData: {} });
    expect(results.map((result) => [result.id, result.paidBy, result.txRef])).toEqual([
      ['entry-20', 'agent', '0x1'],
      ['entry-18', 'human', '0x2'],
    ]);
    expect(results[1].amount).toBe(12.5);
  });

  it('New Ledger Entry passes the domain and actor to the API and keeps only the actions listed', async () => {
    nock(API)
      .get('/api/v1/ledger')
      .query({ order: 'desc', limit: '100', domain: 'compliance', actor: 'system' })
      .reply(200, page([entry(3, { action: 'vendor_earned' }), entry(2, { action: 'screening_run' }), entry(1, { action: 'ap_flag_fraud' })]));
    const results = await appTester(App.triggers.ledger_entry.operation.perform, {
      authData,
      inputData: { domain: 'compliance', actor: 'system', actions: ' vendor_earned, ap_flag_fraud ,' },
    });
    expect(results.map((result) => result.action)).toEqual(['vendor_earned', 'ap_flag_fraud']);
  });

  it('every trigger outputs an id, as Zapier de-duplicates on it, and has a sample with one', () => {
    for (const trigger of Object.values(App.triggers)) {
      expect(trigger.operation.sample.id, trigger.key).toBeTruthy();
      expect(trigger.operation.type, trigger.key).toBe('polling');
    }
  });

  it('the counterparty dropdown lists vendors and contractors, labelled with their role', async () => {
    nock(API)
      .get('/api/v1/counterparties')
      .query({ limit: '200' })
      .reply(200, {
        data: [
          { id: 'cp-1', name: 'Northwind Design', role: 'vendor' },
          { id: 'cp-2', name: 'Harbor Client', role: 'client' },
          { id: 'cp-3', name: 'Mara Lind', role: 'contractor' },
        ],
        page: { nextCursor: 'next-1', hasMore: true, count: 3 },
      });
    const results = await appTester(App.triggers.counterparty_list.operation.perform, { authData, inputData: {} });
    expect(results.map((result) => [result.id, result.label])).toEqual([
      ['cp-1', 'Northwind Design (vendor)'],
      ['cp-3', 'Mara Lind (contractor)'],
    ]);
    expect(App.triggers.counterparty_list.display.hidden).toBe(true);
  });
});

describe('Create Bill (Zapier Z5)', () => {
  const perform = App.creates.create_bill.operation.perform;

  it('adds a payable with the fields given, the day of the due date, and the idempotency key as a header', async () => {
    nock(API, { reqheaders: { 'idempotency-key': 'gmail-18f2c', authorization: `Bearer ${KEY}` } })
      .post('/api/v1/invoices', {
        direction: 'payable',
        counterpartyId: 'cp-1',
        amount: '1250.50',
        currency: 'EURC',
        dueDate: '2026-11-30',
        poReference: 'PO-1042',
        memo: 'November design work',
        goodsReceived: true,
        earlyPayDiscount: { percent: '2', deadline: '2026-11-15' },
      })
      .reply(201, { data: { id: 'inv-9', status: 'pending' } });
    const bill = await appTester(perform, {
      authData,
      inputData: {
        counterpartyId: ' cp-1 ',
        amount: '1250.50',
        dueDate: '2026-11-30T00:00:00-05:00',
        currency: 'EURC',
        poReference: 'PO-1042',
        memo: 'November design work',
        goodsReceived: 'true',
        discountPercent: '2',
        discountDeadline: '2026-11-15',
        idempotencyKey: 'gmail-18f2c',
      },
    });
    expect(bill).toEqual({ id: 'inv-9', status: 'pending' });
  });

  it('sends USDC when no currency is given, and leaves out what is empty', async () => {
    nock(API)
      .post('/api/v1/invoices', { direction: 'payable', counterpartyId: 'cp-1', amount: '12', currency: 'USDC', dueDate: '2026-12-01' })
      .reply(201, { data: { id: 'inv-10' } });
    await appTester(perform, { authData, inputData: { counterpartyId: 'cp-1', amount: '12', dueDate: '2026-12-01', memo: '  ', goodsReceived: '' } });
  });

  it('refuses a bill with no counterparty, amount or due date, or half a discount, before any request', async () => {
    const base = { counterpartyId: 'cp-1', amount: '12', dueDate: '2026-12-01' };
    await expect(appTester(perform, { authData, inputData: { ...base, counterpartyId: '' } })).rejects.toThrow('Choose the counterparty');
    await expect(appTester(perform, { authData, inputData: { ...base, amount: '' } })).rejects.toThrow("Give the bill's amount");
    await expect(appTester(perform, { authData, inputData: { ...base, dueDate: 'next Friday-ish' } })).rejects.toThrow('next Friday-ish');
    await expect(appTester(perform, { authData, inputData: { ...base, discountPercent: '2' } })).rejects.toThrow('needs both its percent and its deadline');
  });

  it("passes the API's refusal on, as its message", async () => {
    nock(API).post('/api/v1/invoices').reply(400, { error: { code: 'invalid_request', message: 'counterpartyId is not a counterparty of this workspace.' } });
    await expect(appTester(perform, { authData, inputData: { counterpartyId: 'cp-x', amount: '12', dueDate: '2026-12-01' } })).rejects.toThrow(
      'counterpartyId is not a counterparty of this workspace.',
    );
  });

  it('reads a due date as its day, whatever form a Zap maps it in', () => {
    expect(dayOf('2026-11-30')).toBe('2026-11-30');
    expect(dayOf('2026-11-30T23:30:00+07:00')).toBe('2026-11-30');
    expect(dayOf('2026-11-30 10:00')).toBe('2026-11-30');
    expect(dayOf('')).toBeNull();
    expect(dayOf('soon')).toBeNull();
  });
});

describe('the package (Zapier Z2, Z6)', () => {
  it('keeps the integration private to its code: no key, deploy key or Zapier config is committed', () => {
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const line of ['node_modules/', '.env', '.environment']) expect(ignore).toContain(line);
  });

  it('never approves or pays: the only write is adding a bill', () => {
    const source = ['creates/createBill.js', 'triggers/agentDecision.js', 'triggers/billPaid.js', 'triggers/ledgerEntry.js', 'triggers/counterpartyList.js', 'lib/http.js', 'lib/ledger.js']
      .map((file) => readFileSync(path.join(root, file), 'utf8'))
      .join('\n');
    expect(source.match(/method: '(POST|PUT|PATCH|DELETE)'/g)).toEqual(["method: 'POST'"]);
    const paths = [...new Set([...source.matchAll(/path: '([^']+)'/g)].map((match) => match[1]))].sort();
    // Reads the ledger and the counterparties, adds invoices: no approval, payment or settings path.
    expect(paths).toEqual(['/api/v1/counterparties', '/api/v1/invoices', '/api/v1/ledger']);
  });
});
