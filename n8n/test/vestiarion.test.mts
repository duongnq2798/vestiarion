import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { Vestiarion } from '../nodes/Vestiarion/Vestiarion.node';
import { VestiarionApi } from '../credentials/VestiarionApi.credentials';
import { api, CREDENTIALS, example, executeContext } from './harness';

/** The Vestiarion node against the API's recorded answers: each operation's request, its output and its errors. */

const node = new Vestiarion();
const COUNTERPARTY = { mode: 'list', value: '6b361405-cfda-4400-a286-364b561911ce' };
const ok = (name: string, statusCode = 200) => ({ statusCode, body: example(name) });
const run = (context: unknown) => node.execute.call(context as IExecuteFunctions);

describe('the credential', () => {
	it('sends the key as a bearer token, and tests it with one read of the status', () => {
		const credential = new VestiarionApi();
		expect(credential.authenticate).toEqual({ type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } } });
		expect(credential.test.request).toMatchObject({ baseURL: '={{$credentials.baseUrl}}', url: '/api/v1/status', method: 'GET' });
		const fields = Object.fromEntries(credential.properties.map((field) => [field.name, field]));
		expect(fields.apiKey.typeOptions?.password).toBe(true);
		expect(fields.webhookSecret.typeOptions?.password).toBe(true);
		expect(fields.baseUrl.default).toBe('https://www.vestiarion.xyz');
	});
});

describe('Bill: Create', () => {
	const base = { resource: 'bill', operation: 'create', counterparty: COUNTERPARTY, amount: '1250.50', dueDate: '2026-11-30T00:00:00', currency: 'USDC' };

	it('adds a payable with POST /api/v1/invoices and outputs the bill the API added', async () => {
		const transport = api({ 'POST /api/v1/invoices': ok('create-invoice', 201) });
		const [items] = await run(executeContext([{ ...base, additionalFields: { poReference: ' PO-4012 ', goodsReceived: true, memo: 'Print run', idempotencyKey: 'inv-42' } }], transport));
		expect(transport.sent).toHaveLength(1);
		const { credential, request } = transport.sent[0];
		expect(credential).toBe('vestiarionApi');
		expect(request.url).toBe('https://www.vestiarion.xyz/api/v1/invoices');
		expect(request.body).toEqual({ direction: 'payable', counterpartyId: COUNTERPARTY.value, amount: '1250.50', currency: 'USDC', dueDate: '2026-11-30', poReference: 'PO-4012', goodsReceived: true, memo: 'Print run' });
		expect(request.headers).toMatchObject({ 'Idempotency-Key': 'inv-42' });
		expect(items).toEqual([{ json: example('create-invoice').data, pairedItem: { item: 0 } }]);
	});

	it('sends no Idempotency-Key unless one is given, and an early-payment discount as percent and deadline', async () => {
		const transport = api({ 'POST /api/v1/invoices': ok('create-invoice', 201) });
		await run(executeContext([{ ...base, additionalFields: { discountPercent: 2, discountDeadline: '2026-11-10T00:00:00' } }], transport));
		expect(transport.sent[0].request.headers).not.toHaveProperty('Idempotency-Key');
		expect(transport.sent[0].request.body).toMatchObject({ earlyPayDiscount: { percent: '2', deadline: '2026-11-10' } });
	});

	it.each([
		[{ amount: ' ' }, /amount/],
		[{ dueDate: '' }, /due date/],
		[{ counterparty: { mode: 'id', value: '' } }, /counterparty/],
		[{ additionalFields: { discountPercent: 2 } }, /both its percent and its deadline/],
	])('refuses %j before sending anything', async (change, message) => {
		const transport = api({});
		await expect(run(executeContext([{ ...base, ...change }], transport))).rejects.toThrow(message);
		expect(transport.sent).toEqual([]);
	});

	it('turns an API error into a NodeApiError with the API\'s message, status and code', async () => {
		const transport = api({
			'POST /api/v1/invoices': { statusCode: 403, body: { error: { code: 'forbidden', message: 'This key cannot add records.' } } },
		});
		const failure = await run(executeContext([base], transport)).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(NodeApiError);
		expect((failure as NodeApiError).message).toBe('This key cannot add records.');
		expect((failure as NodeApiError).description).toBe('HTTP 403 forbidden.');
		expect((failure as NodeApiError).httpCode).toBe('403');
	});

	it('says when to retry after a 429', async () => {
		const transport = api({
			'POST /api/v1/invoices': { statusCode: 429, headers: { 'retry-after': '60' }, body: { error: { code: 'rate_limited', message: 'Too many writes.' } } },
		});
		await expect(run(executeContext([base], transport))).rejects.toMatchObject({ description: 'HTTP 429 rate_limited. Retry after 60 s.' });
	});

	it('keeps going with Continue On Fail, one output per item', async () => {
		let calls = 0;
		const transport = api({
			'POST /api/v1/invoices': () => (++calls === 1 ? { statusCode: 400, body: { error: { code: 'invalid_request', message: 'counterpartyId is not one of this workspace\'s.' } } } : ok('create-invoice', 201)),
		});
		const [items] = await run(executeContext([base, base], transport, { continueOnFail: true }));
		expect(items).toEqual([
			{ json: { error: 'counterpartyId is not one of this workspace\'s.' }, pairedItem: { item: 0 } },
			{ json: example('create-invoice').data, pairedItem: { item: 1 } },
		]);
	});
});

describe('Get Many', () => {
	it('lists bills as payables with the filters, and stops at the limit', async () => {
		const transport = api({ 'GET /api/v1/invoices': ok('list-invoices') });
		const [items] = await run(executeContext([{ resource: 'bill', operation: 'getAll', returnAll: false, limit: 1, filters: { status: 'held', counterpartyId: '' } }], transport));
		expect(transport.sent[0].request.qs).toEqual({ direction: 'payable', status: 'held', limit: 1 });
		expect(items).toHaveLength(1);
	});

	it('reads every page with Return All, following each cursor, and never one the API gave before', async () => {
		const record = (id: string) => ({ id, name: id, role: 'vendor' });
		const pages: Record<string, IDataObject> = {
			first: { data: [record('a')], page: { nextCursor: 'c1', hasMore: true, count: 1 } },
			c1: { data: [record('b')], page: { nextCursor: 'c2', hasMore: true, count: 1 } },
			c2: { data: [record('c')], page: { nextCursor: 'c1', hasMore: true, count: 1 } },
		};
		const transport = api({ 'GET /api/v1/counterparties': (request) => ({ statusCode: 200, body: pages[String((request.qs as IDataObject).cursor ?? 'first')] }) });
		const [items] = await run(executeContext([{ resource: 'counterparty', operation: 'getAll', returnAll: true, filters: { role: 'vendor' } }], transport));
		expect(items.map((item) => item.json.id)).toEqual(['a', 'b', 'c']);
		expect(transport.sent.map((sent) => (sent.request.qs as IDataObject).cursor)).toEqual([undefined, 'c1', 'c2']);
		expect(transport.sent[0].request.qs).toMatchObject({ role: 'vendor', limit: 200 });
	});

	it('reads the agent\'s decisions from the ledger, each with the cursor to resume from', async () => {
		const transport = api({ 'GET /api/v1/ledger': ok('list-ledger-entries') });
		const [items] = await run(executeContext([{ resource: 'decision', operation: 'getAll', returnAll: false, limit: 1, options: { domain: 'ap', cursor: 'eyJrIjo4MH0' } }], transport));
		expect(transport.sent[0].request.qs).toEqual({ actor: 'agent', domain: 'ap', limit: 1, cursor: 'eyJrIjo4MH0' });
		const first = (example('list-ledger-entries').data as IDataObject[])[0];
		expect(items[0].json).toEqual({ ...first, cursor: (example('list-ledger-entries').page as IDataObject).nextCursor });
	});
});

describe('Counterparty: Get and Workspace: Get Status', () => {
	it('reads one counterparty by the id the locator gives, and the status', async () => {
		const id = '6b361405-cfda-4400-a286-364b561911ce';
		const transport = api({ [`GET /api/v1/counterparties/${id}`]: ok('get-counterparty'), 'GET /api/v1/status': ok('get-status') });
		const [one] = await run(executeContext([{ resource: 'counterparty', operation: 'get', counterparty: { mode: 'id', value: id } }], transport));
		expect(one[0].json).toEqual(example('get-counterparty').data);
		const [status] = await run(executeContext([{ resource: 'workspace', operation: 'getStatus' }], transport));
		expect(status[0].json).toEqual(example('get-status').data);
	});

	it('refuses an operation it does not know as a NodeOperationError', async () => {
		await expect(run(executeContext([{ resource: 'bill', operation: 'pay' }], api({})))).rejects.toBeInstanceOf(NodeOperationError);
	});
});

describe('the counterparty picker', () => {
	it('lists counterparties by name and role, filtered by the search, and pages with the API\'s cursor', async () => {
		const transport = api({
			'GET /api/v1/counterparties': {
				statusCode: 200,
				body: { data: [{ id: '1', name: 'Harbor Print Co.', role: 'vendor' }, { id: '2', name: 'Lumen Dev', role: 'contractor' }], page: { nextCursor: 'n1', hasMore: true, count: 2 } },
			},
		});
		const context = { getCredentials: async () => CREDENTIALS, getNode: () => ({}), helpers: { httpRequestWithAuthentication: transport.httpRequestWithAuthentication } };
		const found = await node.methods.listSearch.searchCounterparties.call(context as unknown as ILoadOptionsFunctions, 'harbor');
		expect(found).toEqual({ results: [{ name: 'Harbor Print Co. (vendor)', value: '1' }], paginationToken: 'n1' });
	});
});

describe('the description', () => {
	it('never names an operation the API lacks, and every operation is a read or a bill', () => {
		const operations = node.description.properties.filter((property: INodeProperties) => property.name === 'operation').flatMap((property) => (property.options ?? []).map((option) => (option as { value: string }).value));
		expect(new Set(operations)).toEqual(new Set(['create', 'getAll', 'get', 'getStatus']));
		expect(node.description.usableAsTool).toBe(true);
	});
});
