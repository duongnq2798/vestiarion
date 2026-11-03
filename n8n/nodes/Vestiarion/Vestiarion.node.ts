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
import { dayOf, vestiarionList, vestiarionRequest } from './GenericFunctions';

/**
 * The Vestiarion node (docs/superpowers/specs/2026-11-03-n8n-node-design.md): adds bills for the agent to decide and
 * reads bills, counterparties, the agent's decisions and the workspace's status, through `/api/v1` with a workspace
 * API key. It never approves or pays: no key can.
 */

const INVOICE_STATUSES = ['pending', 'matched', 'scheduled', 'paid', 'held', 'flagged', 'awaiting_info', 'received', 'rejected'];
const COUNTERPARTY_ROLES = ['vendor', 'client', 'contractor'];
const COUNTERPARTY_RISK_LEVELS = ['unscreened', 'clear', 'medium', 'high'];
const LEDGER_DOMAINS = ['ap', 'ar', 'contractor', 'treasury', 'compliance', 'system'];
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const options = (values: string[]) => values.map((value) => ({ name: value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), value }));

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

const counterpartyLocator = (resource: string, operation: string, description: string): INodeTypeDescription['properties'][number] => ({
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
			typeOptions: { searchListMethod: 'searchCounterparties', searchable: true },
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
						description: 'List the ledger entries the agent signed, oldest first, with its reasoning',
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
			counterpartyLocator('bill', 'create', 'The vendor the bill is from'),
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
				displayName: 'Currency',
				name: 'currency',
				type: 'options',
				options: [
					{ name: 'USDC', value: 'USDC' },
					{ name: 'EURC', value: 'EURC' },
				],
				default: 'USDC',
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
						description: 'Your own record\'s ID, such as the invoice\'s ID in the tool it comes from, so a rerun cannot add the bill twice',
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
					{ displayName: 'Status', name: 'status', type: 'options', options: options(INVOICE_STATUSES), default: 'held', description: 'Only bills in this status' },
				],
			},

			// Counterparty: Get, Get Many
			counterpartyLocator('counterparty', 'get', 'The counterparty to get'),
			...pageFields('counterparty'),
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['counterparty'], operation: ['getAll'] } },
				options: [
					{ displayName: 'Risk Level', name: 'riskLevel', type: 'options', options: options(COUNTERPARTY_RISK_LEVELS), default: 'high' },
					{ displayName: 'Role', name: 'role', type: 'options', options: options(COUNTERPARTY_ROLES), default: 'vendor' },
				],
			},

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
						description: 'Continue from a cursor an earlier read gave, as the last item\'s cursor field. Entries come oldest first.',
					},
					{ displayName: 'Domain', name: 'domain', type: 'options', options: options(LEDGER_DOMAINS), default: 'ap', description: 'Only decisions in this domain: ap is bills' },
				],
			},
		],
	};

	methods = {
		listSearch: {
			/** Counterparties by name, page by page as the API pages them; the search filters each page. */
			async searchCounterparties(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
				const answer = await vestiarionRequest.call(this, 'GET', '/api/v1/counterparties', {
					qs: { limit: 200, ...(paginationToken ? { cursor: paginationToken } : {}) },
				});
				const wanted = (filter ?? '').trim().toLowerCase();
				const records = (Array.isArray(answer.data) ? answer.data : []) as IDataObject[];
				const page = (answer.page ?? {}) as IDataObject;
				return {
					results: records
						.filter((record) => wanted === '' || String(record.name).toLowerCase().includes(wanted))
						.map((record) => ({ name: `${String(record.name)} (${String(record.role)})`, value: String(record.id) })),
					paginationToken: page.hasMore === true && typeof page.nextCursor === 'string' ? page.nextCursor : undefined,
				};
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
				} else if (resource === 'counterparty' && operation === 'get') {
					const id = this.getNodeParameter('counterparty', i, '', { extractValue: true }) as string;
					const answer = await vestiarionRequest.call(this, 'GET', `/api/v1/counterparties/${encodeURIComponent(id)}`, { itemIndex: i });
					results = [answer.data as IDataObject];
				} else if (resource === 'counterparty' && operation === 'getAll') {
					const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
					results = await vestiarionList.call(this, '/api/v1/counterparties', pick(filters, ['role', 'riskLevel']), page(this, i));
				} else if (resource === 'decision' && operation === 'getAll') {
					const extra = this.getNodeParameter('options', i, {}) as IDataObject;
					results = await decisions.call(this, i, extra);
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
	const counterpartyId = (this.getNodeParameter('counterparty', i, '', { extractValue: true }) as string).trim();
	const amount = String(this.getNodeParameter('amount', i, '')).trim();
	const dueDate = dayOf(this.getNodeParameter('dueDate', i, ''));
	const currency = this.getNodeParameter('currency', i, 'USDC') as string;
	const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	if (counterpartyId === '') throw new NodeOperationError(this.getNode(), 'Choose the counterparty the bill is from', { itemIndex: i });
	if (amount === '') throw new NodeOperationError(this.getNode(), 'Give the bill\'s amount, such as 1250.50', { itemIndex: i });
	if (!dueDate) throw new NodeOperationError(this.getNode(), 'Give the bill\'s due date', { itemIndex: i });

	const body: IDataObject = { direction: 'payable', counterpartyId, amount, currency, dueDate };
	if (typeof extra.poReference === 'string' && extra.poReference.trim() !== '') body.poReference = extra.poReference.trim();
	if (typeof extra.memo === 'string' && extra.memo.trim() !== '') body.memo = extra.memo.trim();
	if (extra.goodsReceived !== undefined) body.goodsReceived = extra.goodsReceived === true;
	const percent = typeof extra.discountPercent === 'number' && extra.discountPercent > 0 ? extra.discountPercent : null;
	const deadline = dayOf(extra.discountDeadline);
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
	for (;;) {
		const wanted = returnAll ? 200 : Math.min(200, limit - records.length);
		const answer = await vestiarionRequest.call(this, 'GET', '/api/v1/ledger', { qs: { ...qs, limit: wanted, ...(cursor ? { cursor } : {}) }, itemIndex: i });
		const pageInfo = (answer.page ?? {}) as IDataObject;
		const next = typeof pageInfo.nextCursor === 'string' ? pageInfo.nextCursor : null;
		// The ledger's cursor is a watermark: reading from it again returns nothing before it, so each entry carries it.
		for (const entry of (Array.isArray(answer.data) ? answer.data : []) as IDataObject[]) records.push({ ...entry, cursor: next ?? cursor ?? null });
		if (pageInfo.hasMore !== true || !next || seen.has(next)) break;
		if (!returnAll && records.length >= limit) break;
		seen.add(next);
		cursor = next;
	}
	return returnAll ? records : records.slice(0, limit);
}
