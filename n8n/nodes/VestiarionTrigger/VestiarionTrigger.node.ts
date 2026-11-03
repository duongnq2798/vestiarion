import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { checkSignature } from './signature';

/**
 * The Vestiarion Trigger (docs/superpowers/specs/2026-11-03-n8n-node-design.md): starts a workflow on each signed
 * delivery a workspace's webhook endpoint sends, one per ledger entry, after checking its Vestiarion-Signature. The API
 * cannot add a webhook endpoint, so an owner or an admin adds this node's URL in the workspace's Settings by hand.
 */

const LEDGER_DOMAINS = ['ap', 'ar', 'contractor', 'treasury', 'compliance', 'system'];
const DOMAIN_NAMES: Record<string, string> = {
	ap: 'Bills (ap)',
	ar: 'Receivables (ar)',
	contractor: 'Contractor Milestones (contractor)',
	treasury: 'Treasury (treasury)',
	compliance: 'Screening and Payees (compliance)',
	system: 'Workspace (system)',
};

export class VestiarionTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vestiarion Trigger',
		name: 'vestiarionTrigger',
		icon: { light: 'file:../../icons/vestiarion.svg', dark: 'file:../../icons/vestiarion.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"] === "agent" ? "Agent decisions" : "Every ledger entry"}}',
		description: 'Starts the workflow when Vestiarion signs a ledger entry, such as a decision of its agent',
		defaults: { name: 'Vestiarion Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'vestiarionApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName:
					'Add this node\'s Production URL as a webhook endpoint in Vestiarion: an owner or an admin does it on the workspace\'s Settings page, under Webhooks. Put the signing secret it shows into the credential\'s Webhook Signing Secret. To try it, add the Test URL instead, choose Listen for Test Event here, then Send test in Settings.',
				name: 'setup',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'options',
				options: [
					{ name: 'Agent Decisions', value: 'agent', description: 'Entries the agent signed: what it paid, held, flagged or scheduled, and why' },
					{ name: 'Every Ledger Entry', value: 'all', description: 'Entries by the agent, people and the system alike' },
				],
				default: 'agent',
			},
			{
				displayName: 'Domains',
				name: 'domains',
				type: 'multiOptions',
				options: LEDGER_DOMAINS.map((value) => ({ name: DOMAIN_NAMES[value], value })),
				default: [],
				description: 'Only entries in these domains. Leave it empty for every domain.',
			},
			{
				displayName: 'Actions',
				name: 'actions',
				type: 'string',
				default: '',
				placeholder: 'ap_pay, ap_hold',
				description: 'Only entries with one of these actions, separated by commas. Leave it empty for every action.',
			},
			{
				displayName: 'Include Test Deliveries',
				name: 'includeTests',
				type: 'boolean',
				default: true,
				description: 'Whether a delivery sent with Send test in Settings starts the workflow. It carries no entry.',
			},
		],
	};

	// The API has no endpoint to add or remove a webhook endpoint: Settings does it, by hand. So each of these answers
	// that the endpoint is there and does nothing; the node's notice says how to add it.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const credentials = await this.getCredentials('vestiarionApi');
		const secret = typeof credentials.webhookSecret === 'string' ? credentials.webhookSecret.trim() : '';
		if (secret === '') {
			throw new NodeOperationError(this.getNode(), 'The credential has no Webhook Signing Secret', {
				description: 'Put in the signing secret Settings showed when the webhook endpoint was added, whsec_ included.',
			});
		}

		const request = this.getRequestObject();
		if (!request.rawBody) await request.readRawBody();
		const rawBody = request.rawBody ? request.rawBody.toString('utf8') : '';
		const headers = this.getHeaderData() as IDataObject;
		const header = typeof headers['vestiarion-signature'] === 'string' ? headers['vestiarion-signature'] : undefined;
		const check = checkSignature(secret, rawBody, header, Date.now());
		const response = this.getResponseObject();
		if (!check.ok) {
			response.status(401).json({ error: check.reason }).end();
			return { noWebhookResponse: true };
		}

		let delivery: IDataObject;
		try {
			delivery = JSON.parse(rawBody) as IDataObject;
		} catch {
			response.status(400).json({ error: 'The body is not JSON.' }).end();
			return { noWebhookResponse: true };
		}
		if (!wanted(this, delivery)) {
			// Answered 2xx, so Vestiarion counts it delivered and does not try again.
			response.status(200).json({ received: true, started: false }).end();
			return { noWebhookResponse: true };
		}
		return { workflowData: [this.helpers.returnJsonArray(delivery)] };
	}
}

/** Whether a signed delivery passes the node's filters. */
function wanted(context: IWebhookFunctions, delivery: IDataObject): boolean {
	if (delivery.type === 'webhook.test') return context.getNodeParameter('includeTests', true) === true;
	if (delivery.type !== 'ledger.appended') return false;
	const entry = (typeof delivery.entry === 'object' && delivery.entry !== null ? delivery.entry : {}) as IDataObject;
	if (context.getNodeParameter('events', 'agent') === 'agent' && entry.actor !== 'agent') return false;
	const domains = context.getNodeParameter('domains', []) as string[];
	if (domains.length > 0 && !domains.includes(String(entry.domain))) return false;
	const actions = String(context.getNodeParameter('actions', ''))
		.split(',')
		.map((action) => action.trim())
		.filter(Boolean);
	return actions.length === 0 || actions.includes(String(entry.action));
}
