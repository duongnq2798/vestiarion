import type {
	IDataObject,
	JsonObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { COUNTERPARTY_ROLE_OPTIONS, INVOICE_STATUS_OPTIONS, LEDGER_DOMAIN_OPTIONS, RISK_LEVEL_OPTIONS } from './constants';
import { dayOf, vestiarionList, vestiarionRequest } from './GenericFunctions';

/**
 * The Vestiarion node (docs/superpowers/specs/2026-11-03-n8n-node-design.md): adds bills for the agent to decide and
 * reads bills, counterparties, the agent's decisions and the workspace's status, through `/api/v1` with a workspace
 * API key. It never approves or pays: no key can.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** The Simplify switch every Get Many has, as n8n's UX guidelines ask of answers over ten fields. */
const simplifyField = (resource: string): INodeTypeDescription['properties'][number] => ({
	displayName: 'Simplify',
	name: 'simplify',
	type: 'boolean',
	displayOptions: { show: { resource: [resource], operation: ['getAll'] } },
	default: true,
	description: 'Whether to return a simplified version of the response instead of the raw data',
});

/** The paging fields every Get Many takes. */
const pageFields = (resource: string, operation = 'getAll'): INodeTypeDescription['properties'] => [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: { show: { resource: [resource], operation: [operation] } },
		default: false,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		displayOptions: { show: { resource: [resource], operation: [operation], returnAll: [false] } },
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
	},
];

const counterpartyLocator = (resource: string, operation: string, description: string, searchListMethod: string): INodeTypeDescription['properties'][number] => ({
	displayName: 'Counterparty',
	name: 'counterparty',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description,
	displayOptions: { show: { resource: [resource], operation: [operation] } },
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod, searchable: true },
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: '6b361405-cfda-4400-a286-364b561911ce',
			validation: [{ type: 'regex', properties: { regex: UUID, errorMessage: 'A counterparty ID is a UUID' } }],
		},
	],
});

export class Vestiarion implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vestiarion',
		name: 'vestiarion',
		icon: { light: 'file:../../icons/vestiarion.svg', dark: 'file:../../icons/vestiarion.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Add bills for the Vestiarion agent to decide, and read its decisions',
		defaults: { name: 'Vestiarion' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'vestiarionApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Bill', value: 'bill' },
					{ name: 'Counterparty', value: 'counterparty' },
					{ name: 'Decision', value: 'decision' },
					{ name: 'Workspace', value: 'workspace' },
				],
				default: 'bill',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['bill'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a bill',
						description: 'Add a bill for the agent to decide, as one typed into the console',
					},
					{ name: 'Get Many', value: 'getAll', action: 'Get many bills', description: 'List bills, newest first' },
				],
				default: 'create',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['counterparty'] } },
				options: [
					{ name: 'Get', value: 'get', action: 'Get a counterparty', description: 'Get one counterparty, with its recent screenings' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many counterparties', description: 'List vendors, clients and contractors' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['decision'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many decisions',
						description: 'List the ledger entries the agent signed, oldest first, with its reasoning. For decisions as they happen, use the Vestiarion Trigger.',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['workspace'] } },
				options: [
					{
						name: 'Get Status',
						value: 'getStatus',
						action: 'Get the workspace status',
						description: 'What the workspace can do now: payments, yield, screening, its clock and totals',
					},
				],
				default: 'getStatus',
			},

			// Bill: Create
			counterpartyLocator('bill', 'create', 'The vendor or contractor the bill is from', 'searchPayees'),
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'string',
				required: true,
				default: '',
				placeholder: '1250.50',
				description: 'What the bill is for, in its currency, with at most 6 decimal places',
				displayOptions: { show: { resource: ['bill'], operation: ['create'] } },
			},
			{
				displayName: 'Due Date',
				name: 'dueDate',
				type: 'dateTime',
				required: true,
				default: '',
				description: 'The day the bill is due',
				displayOptions: { show: { resource: ['bill'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['bill'], operation: ['create'] } },
				options: [
					{
						displayName: 'Currency',
						name: 'currency',
						type: 'options',
						options: [
							{ name: 'EURC', value: 'EURC' },
							{ name: 'USDC', value: 'USDC' },
						],
						default: 'USDC',
						description: 'The currency the bill is in. Without this field, USDC.',
					},
					{
						displayName: 'Early-Payment Discount Deadline',
						name: 'discountDeadline',
						type: 'dateTime',
						default: '',
						description: 'The last day the discount applies, on or before the due date. Goes with the percent.',
					},
					{
						displayName: 'Early-Payment Discount Percent',
						name: 'discountPercent',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 100, numberPrecision: 2 },
						default: 0,
						description: 'The percent off for paying by the deadline. Goes with the deadline.',
					},
					{
						displayName: 'Goods Received',
						name: 'goodsReceived',
						type: 'boolean',
						default: false,
						description: 'Whether what the bill is for has arrived. Without it, or without a PO reference, the agent asks for the missing detail instead of paying.',
					},
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						placeholder: 'billing-inv-2026-0042',
						description: 'Your own record\'s ID, such as the invoice\'s ID in the tool it comes from, so a rerun within 24 hours adds the bill once. Up to 255 characters, with no spaces. The API keeps a key for 24 hours.',
					},
					{
						displayName: 'Memo',
						name: 'memo',
						type: 'string',
						default: '',
						description: 'What the bill is for, up to 280 characters',
					},
					{
						displayName: 'PO Reference',
						name: 'poReference',
						type: 'string',
						default: '',
						description: 'The purchase order the bill is billed against, up to 100 characters',
					},
				],
			},

			// Bill: Get Many
			...pageFields('bill'),
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['bill'], operation: ['getAll'] } },
				options: [
					{ displayName: 'Counterparty ID', name: 'counterpartyId', type: 'string', default: '', description: 'Only bills from this counterparty' },
					{ displayName: 'Status', name: 'status', type: 'options', options: INVOICE_STATUS_OPTIONS, default: 'held', description: 'Only bills in this status' },
				],
			},
			simplifyField('bill'),

			// Counterparty: Get, Get Many
			counterpartyLocator('counterparty', 'get', 'The counterparty to get', 'searchCounterparties'),
			...pageFields('counterparty'),
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['counterparty'], operation: ['getAll'] } },
				options: [
					{ displayName: 'Risk Level', name: 'riskLevel', type: 'options', options: RISK_LEVEL_OPTIONS, default: 'high' },
					{ displayName: 'Role', name: 'role', type: 'options', options: COUNTERPARTY_ROLE_OPTIONS, default: 'vendor' },
				],
			},
			simplifyField('counterparty'),

			// Decision: Get Many
			...pageFields('decision'),
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['decision'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'After Cursor',
						name: 'cursor',
						type: 'string',
						default: '',
						description: 'Start from a cursor an earlier read gave, its last item\'s cursor field, rather than from the first entry. It can be empty: a read that fits on one page has none.',
					},
					{
						displayName: 'After Seq',
						name: 'afterSeq',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description: 'Leave out entries up to this seq, such as the highest one an earlier run handled, so a scheduled read returns only what is new. 0 leaves none out.',
					},
					{ displayName: 'Domain', name: 'domain', type: 'options', options: LEDGER_DOMAIN_OPTIONS, default: 'ap', description: 'Only decisions in this domain' },
				],
			},
			simplifyField('decision'),
		],
	};

	methods = {
		listSearch: {
			/** Every counterparty by name, page by page as the API pages them; the search filters each page. */
			async searchCounterparties(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
				return searchPage.call(this, filter, paginationToken, () => true);
			},
			/** The counterparties a bill can be from: vendors and contractors, not clients. */
			async searchPayees(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
				return searchPage.call(this, filter, paginationToken, (record) => record.role !== 'client');
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let results: IDataObject[];
				if (resource === 'bill' && operation === 'create') {
					results = [await createBill.call(this, i)];
				} else if (resource === 'bill' && operation === 'getAll') {
					const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
					results = await vestiarionList.call(this, '/api/v1/invoices', { direction: 'payable', ...pick(filters, ['status', 'counterpartyId']) }, page(this, i));
					if (this.getNodeParameter('simplify', i, true) === true) results = results.map(simpleBill);
				} else if (resource === 'counterparty' && operation === 'get') {
					const id = String(this.getNodeParameter('counterparty', i, '', { extractValue: true }) ?? '').trim();
					const answer = await vestiarionRequest.call(this, 'GET', `/api/v1/counterparties/${encodeURIComponent(id)}`, { itemIndex: i });
					results = [answer.data as IDataObject];
				} else if (resource === 'counterparty' && operation === 'getAll') {
					const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
					results = await vestiarionList.call(this, '/api/v1/counterparties', pick(filters, ['role', 'riskLevel']), page(this, i));
					if (this.getNodeParameter('simplify', i, true) === true) results = results.map(simpleCounterparty);
				} else if (resource === 'decision' && operation === 'getAll') {
					const extra = this.getNodeParameter('options', i, {}) as IDataObject;
					results = await decisions.call(this, i, extra);
					if (this.getNodeParameter('simplify', i, true) === true) results = results.map(simpleDecision);
				} else if (resource === 'workspace' && operation === 'getStatus') {
					const answer = await vestiarionRequest.call(this, 'GET', '/api/v1/status', { itemIndex: i });
					results = [answer.data as IDataObject];
				} else {
					throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not known for "${resource}"`, { itemIndex: i });
				}
				for (const json of results) returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Either class hands back an error it already is, so the API's message and code are kept.
				if (error instanceof NodeOperationError) throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}
		return [returnData];
	}
}

function page(context: IExecuteFunctions, i: number) {
	const returnAll = context.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? 0 : (context.getNodeParameter('limit', i, 50) as number);
	return { returnAll, limit, itemIndex: i };
}

function pick(source: IDataObject, keys: string[]): IDataObject {
	const kept: IDataObject = {};
	for (const key of keys) if (source[key] !== undefined && source[key] !== '') kept[key] = source[key];
	return kept;
}

/** POST /api/v1/invoices as a payable, with its Idempotency-Key when one is given. */
async function createBill(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const counterpartyId = String(this.getNodeParameter('counterparty', i, '', { extractValue: true }) ?? '').trim();
	const timeZone = this.getTimezone();
	const amount = String(this.getNodeParameter('amount', i, '')).trim();
	const dueDate = dayOf(this.getNodeParameter('dueDate', i, ''), timeZone);
	const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	// Not set is USDC. Anything else goes as given, so the API's 400 names a wrong one rather than a USDC bill.
	const currency = String(extra.currency ?? '').trim() || 'USDC';
	if (counterpartyId === '') throw new NodeOperationError(this.getNode(), 'Choose the counterparty the bill is from', { itemIndex: i });
	if (amount === '') throw new NodeOperationError(this.getNode(), 'Give the bill\'s amount, such as 1250.50', { itemIndex: i });
	if (!dueDate) {
		throw new NodeOperationError(this.getNode(), 'Give the bill\'s due date as a date, such as 2026-11-30', {
			itemIndex: i,
			description: `The field holds ${shown(this.getNodeParameter('dueDate', i, ''))}, which is not a date.`,
		});
	}

	const body: IDataObject = { direction: 'payable', counterpartyId, amount, currency, dueDate };
	if (typeof extra.poReference === 'string' && extra.poReference.trim() !== '') body.poReference = extra.poReference.trim();
	if (typeof extra.memo === 'string' && extra.memo.trim() !== '') body.memo = extra.memo.trim();
	if (extra.goodsReceived !== undefined) body.goodsReceived = extra.goodsReceived === true;
	const percent = typeof extra.discountPercent === 'number' && extra.discountPercent > 0 ? extra.discountPercent : null;
	const deadline = dayOf(extra.discountDeadline, timeZone);
	if ((percent === null) !== (deadline === null)) {
		throw new NodeOperationError(this.getNode(), 'An early-payment discount needs both its percent and its deadline', { itemIndex: i });
	}
	if (percent !== null && deadline !== null) body.earlyPayDiscount = { percent: String(percent), deadline };

	const key = typeof extra.idempotencyKey === 'string' ? extra.idempotencyKey.trim() : '';
	const answer = await vestiarionRequest.call(this, 'POST', '/api/v1/invoices', {
		body,
		headers: key !== '' ? { 'Idempotency-Key': key } : {},
		itemIndex: i,
	});
	return answer.data as IDataObject;
}

/** The agent's ledger entries, oldest first, each with the cursor to continue from after it. */
async function decisions(this: IExecuteFunctions, i: number, extra: IDataObject): Promise<IDataObject[]> {
	const { returnAll, limit } = page(this, i);
	const records: IDataObject[] = [];
	const seen = new Set<string>();
	let cursor = typeof extra.cursor === 'string' && extra.cursor.trim() !== '' ? extra.cursor.trim() : undefined;
	const qs: IDataObject = { actor: 'agent', ...(typeof extra.domain === 'string' && extra.domain !== '' ? { domain: extra.domain } : {}) };
	const afterSeq = typeof extra.afterSeq === 'number' && Number.isFinite(extra.afterSeq) ? extra.afterSeq : 0;
	for (;;) {
		const wanted = returnAll ? 200 : Math.min(200, limit - records.length);
		const answer = await vestiarionRequest.call(this, 'GET', '/api/v1/ledger', { qs: { ...qs, limit: wanted, ...(cursor ? { cursor } : {}) }, itemIndex: i });
		const pageInfo = (answer.page ?? {}) as IDataObject;
		const next = typeof pageInfo.nextCursor === 'string' ? pageInfo.nextCursor : null;
		// The ledger's cursor is a watermark: reading from it again returns nothing before it, so each entry carries it.
		for (const entry of (Array.isArray(answer.data) ? answer.data : []) as IDataObject[]) {
			if (afterSeq > 0 && typeof entry.seq === 'number' && entry.seq <= afterSeq) continue;
			records.push({ ...entry, cursor: next ?? cursor ?? null });
		}
		if (pageInfo.hasMore !== true || !next || seen.has(next)) break;
		if (!returnAll && records.length >= limit) break;
		seen.add(next);
		cursor = next;
	}
	return returnAll ? records : records.slice(0, limit);
}

/** One page of the counterparty picker: the API's page, filtered by the search and `keep`. */
async function searchPage(
	this: ILoadOptionsFunctions,
	filter: string | undefined,
	paginationToken: string | undefined,
	keep: (record: IDataObject) => boolean,
): Promise<INodeListSearchResult> {
	const answer = await vestiarionRequest.call(this, 'GET', '/api/v1/counterparties', {
		qs: { limit: 200, ...(paginationToken ? { cursor: paginationToken } : {}) },
	});
	const wanted = (filter ?? '').trim().toLowerCase();
	const records = (Array.isArray(answer.data) ? answer.data : []) as IDataObject[];
	const page = (answer.page ?? {}) as IDataObject;
	return {
		results: records
			.filter((record) => keep(record) && (wanted === '' || String(record.name).toLowerCase().includes(wanted)))
			.map((record) => ({ name: `${String(record.name)} (${String(record.role)})`, value: String(record.id) })),
		paginationToken: page.hasMore === true && typeof page.nextCursor === 'string' ? page.nextCursor : undefined,
	};
}

/** A value as a person can read it in an error, short. */
function shown(value: unknown): string {
	const text = typeof value === 'string' ? JSON.stringify(value) : value === null || value === undefined ? 'nothing' : JSON.stringify(value) ?? String(value);
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const object = (value: unknown): IDataObject => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as IDataObject) : {});

/** A bill's fields a workflow most often maps, from its twenty. */
function simpleBill(bill: IDataObject): IDataObject {
	const counterparty = object(bill.counterparty);
	return {
		id: bill.id,
		status: bill.status,
		amount: bill.amount,
		currency: bill.currency,
		dueDate: bill.dueDate,
		counterpartyId: counterparty.id ?? null,
		counterparty: counterparty.name ?? null,
		poReference: bill.poReference,
		goodsReceived: bill.goodsReceived,
		agentReasoning: bill.agentReasoning,
		decidedAt: bill.decidedAt,
		settledAt: bill.settledAt,
		txHash: bill.txHash,
	};
}

function simpleCounterparty(counterparty: IDataObject): IDataObject {
	return {
		id: counterparty.id,
		name: counterparty.name,
		role: counterparty.role,
		address: counterparty.address,
		chain: counterparty.chain,
		riskLevel: counterparty.riskLevel,
		paymentLimit: counterparty.paymentLimit,
		lastScreenedAt: counterparty.lastScreenedAt,
	};
}

/** A decision without its hashes and signature: what it was, about what, and why. */
function simpleDecision(entry: IDataObject): IDataObject {
	const detail = object(entry.detail);
	const decision = object(detail.decision);
	return {
		seq: entry.seq,
		ts: entry.ts,
		domain: entry.domain,
		action: entry.action,
		summary: entry.summary,
		reasoning: typeof decision.reasoning === 'string' ? decision.reasoning : null,
		invoiceId: detail.invoiceId ?? null,
		milestoneId: detail.milestoneId ?? null,
		cursor: entry.cursor,
	};
}
