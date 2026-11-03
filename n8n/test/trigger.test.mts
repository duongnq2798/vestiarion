import type { IDataObject, IWebhookFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { signWebhook } from '../../src/lib/webhooks/sign';
import { checkSignature, TOLERANCE_SECONDS } from '../nodes/VestiarionTrigger/signature';
import { VestiarionTrigger } from '../nodes/VestiarionTrigger/VestiarionTrigger.node';
import { CREDENTIALS, NODE } from './harness';

/**
 * The Vestiarion Trigger: it starts a workflow only on a delivery Vestiarion's own signer signed, and only one its
 * filters take. Signed with the server's signWebhook, so the node is held to what the app sends.
 */

const SECRET = CREDENTIALS.webhookSecret;
const NOW = 1_762_000_000_000;
const node = new VestiarionTrigger();

const entry = (fields: IDataObject = {}) => ({
	seq: 82,
	ts: '2026-11-03T08:00:00+00:00',
	actor: 'agent',
	domain: 'ap',
	action: 'ap_pay',
	summary: 'AP: pay 1250.50 USDC to Harbor Print Co.',
	detail: { decision: { action: 'pay', reasoning: 'Matched to PO-4012, goods received.' } },
	bodyHash: 'a'.repeat(64),
	prevHash: 'b'.repeat(64),
	hash: 'c'.repeat(64),
	signature: 'd'.repeat(128),
	signingKeyId: '9b03458d9a617871',
	...fields,
});
const delivery = (fields: IDataObject = {}) => ({ id: '3fa1e2b0-0000-4000-8000-000000000001', type: 'ledger.appended', createdAt: '2026-11-03T08:00:00+00:00', workspace: { slug: 'acme' }, entry: entry(), ...fields });

interface Reply {
	status?: number;
	body?: unknown;
}

/** An IWebhookFunctions for one delivery: the raw body as it arrived, its headers, the node's parameters. */
function webhookContext(raw: string, headers: IDataObject, parameters: IDataObject = {}, credentials: IDataObject = CREDENTIALS, unreadable = false) {
	const reply: Reply = {};
	const response = {
		status(code: number) {
			reply.status = code;
			return response;
		},
		json(body: unknown) {
			reply.body = body;
			return response;
		},
		end() {
			return response;
		},
	};
	const values: IDataObject = { events: 'agent', domains: [], actions: '', includeTests: true, ...parameters };
	const context = {
		getCredentials: async () => credentials,
		getNode: () => NODE,
		getRequestObject: () =>
			unreadable
				? { rawBody: undefined, readRawBody: async () => Promise.reject(new Error('The request body is not readable')) }
				: { rawBody: Buffer.from(raw, 'utf8'), readRawBody: async () => undefined },
		getHeaderData: () => headers,
		getResponseObject: () => response,
		getNodeParameter: (name: string, fallback?: unknown) => (name in values ? values[name] : fallback),
		helpers: { returnJsonArray: (data: IDataObject) => [{ json: data }] },
	};
	return { context: context as unknown as IWebhookFunctions, reply };
}

const signed = (raw: string, at = Math.floor(Date.now() / 1000)) => ({ 'vestiarion-signature': signWebhook(SECRET, raw, at) });

describe('checkSignature', () => {
	const raw = JSON.stringify(delivery());
	const t = Math.floor(NOW / 1000);

	it("accepts what the server's signWebhook signs, the secret used as given with whsec_", () => {
		expect(checkSignature(SECRET, raw, signWebhook(SECRET, raw, t), NOW)).toEqual({ ok: true });
	});

	it.each([
		['a changed body', SECRET, `${raw} `, signWebhook(SECRET, raw, t), /does not match/],
		['another secret', 'whsec_other', raw, signWebhook(SECRET, raw, t), /does not match/],
		['the secret without whsec_', SECRET.slice('whsec_'.length), raw, signWebhook(SECRET, raw, t), /does not match/],
		['no header', SECRET, raw, undefined, /no Vestiarion-Signature/],
		['a header of another shape', SECRET, raw, 'sha256=abc', /not t=<seconds>,v1=<hex>/],
		['a signature too old', SECRET, raw, signWebhook(SECRET, raw, t - TOLERANCE_SECONDS - 1), /more than 300 seconds/],
		['a signature from the future', SECRET, raw, signWebhook(SECRET, raw, t + TOLERANCE_SECONDS + 1), /more than 300 seconds/],
		['a short v1', SECRET, raw, `t=${t},v1=abc`, /does not match/],
	])('refuses %s', (_, secret, body, header, reason) => {
		const check = checkSignature(secret, body, header, NOW);
		expect(check.ok).toBe(false);
		expect(check.ok === false && check.reason).toMatch(reason);
	});

	it('accepts any one of several v1 signatures, as a rotated secret sends', () => {
		const good = signWebhook(SECRET, raw, t);
		expect(checkSignature(SECRET, raw, `t=${t},v1=${'0'.repeat(64)},${good.split(',')[1]}`, NOW)).toEqual({ ok: true });
	});
});

describe('the webhook', () => {
	it('starts the workflow with the delivery as it was signed', async () => {
		const raw = JSON.stringify(delivery());
		const { context, reply } = webhookContext(raw, signed(raw));
		const answer = await node.webhook.call(context);
		expect(answer).toEqual({ workflowData: [[{ json: delivery() }]] });
		expect(reply.status).toBeUndefined();
	});

	it('checks the raw bytes: a body signed and sent pretty-printed starts the workflow as it came', async () => {
		// Re-serialising it would give compact JSON, whose signature differs: only the bytes as they arrived verify.
		const raw = JSON.stringify(delivery(), null, 2);
		const { context } = webhookContext(raw, signed(raw));
		expect(await node.webhook.call(context)).toEqual({ workflowData: [[{ json: delivery() }]] });
	});

	it('checks the raw bytes: a body re-serialised after it was signed is refused with 401', async () => {
		const raw = JSON.stringify(delivery(), null, 2);
		const { context, reply } = webhookContext(JSON.stringify(delivery()), signed(raw));
		expect(await node.webhook.call(context)).toEqual({ noWebhookResponse: true });
		expect(reply).toEqual({ status: 401, body: { error: 'The signature does not match the body under this signing secret.' } });
	});

	it('refuses an unsigned delivery with 401, and starts nothing', async () => {
		const raw = JSON.stringify(delivery());
		const { context, reply } = webhookContext(raw, {});
		expect(await node.webhook.call(context)).toEqual({ noWebhookResponse: true });
		expect(reply.status).toBe(401);
	});

	it('answers 400 to a body n8n cannot read raw, such as a form upload, rather than failing a run', async () => {
		const { context, reply } = webhookContext('', {}, {}, CREDENTIALS, true);
		expect(await node.webhook.call(context)).toEqual({ noWebhookResponse: true });
		expect(reply).toEqual({ status: 400, body: { error: 'The body could not be read as it arrived.' } });
	});

	it('fails loudly when the credential has no signing secret, rather than taking every delivery', async () => {
		const raw = JSON.stringify(delivery());
		const { context } = webhookContext(raw, signed(raw), {}, { ...CREDENTIALS, webhookSecret: ' ' });
		await expect(node.webhook.call(context)).rejects.toThrow('The credential has no Webhook Signing Secret');
	});

	it.each([
		['a person\'s entry, with Agent Decisions', delivery({ entry: entry({ actor: 'human' }) }), {}],
		['another domain', delivery({ entry: entry({ domain: 'treasury' }) }), { domains: ['ap'] }],
		['another action', delivery({ entry: entry({ action: 'ap_hold' }) }), { actions: 'ap_pay, ap_flag_fraud' }],
		['a test delivery, with Include Test Deliveries off', { id: 'x', type: 'webhook.test', createdAt: '2026-11-03T08:00:00Z', workspace: { slug: 'acme' } }, { includeTests: false }],
		['an event type it does not know', delivery({ type: 'ledger.rewritten' }), { events: 'all' }],
	])('answers 200 to %s, so Vestiarion does not retry, and starts nothing', async (_, body, parameters) => {
		const raw = JSON.stringify(body);
		const { context, reply } = webhookContext(raw, signed(raw), parameters);
		expect(await node.webhook.call(context)).toEqual({ noWebhookResponse: true });
		expect(reply).toEqual({ status: 200, body: { received: true, started: false } });
	});

	it.each([
		['every entry, a person\'s included', delivery({ entry: entry({ actor: 'human' }) }), { events: 'all' }],
		['a domain and an action it lists', delivery({ entry: entry({ action: 'ap_hold' }) }), { domains: ['ap', 'ar'], actions: 'ap_pay,ap_hold' }],
		['a test delivery', { id: 'x', type: 'webhook.test', createdAt: '2026-11-03T08:00:00Z', workspace: { slug: 'acme' } }, {}],
	])('starts the workflow on %s', async (_, body, parameters) => {
		const raw = JSON.stringify(body);
		const { context } = webhookContext(raw, signed(raw), parameters);
		expect(await node.webhook.call(context)).toEqual({ workflowData: [[{ json: body }]] });
	});

	it('has the lifecycle n8n asks for, and adds nothing anywhere: the endpoint is added in Settings', async () => {
		const hooks = node.webhookMethods.default;
		const hookContext = {} as never;
		expect([await hooks.checkExists.call(hookContext), await hooks.create.call(hookContext), await hooks.delete.call(hookContext)]).toEqual([true, true, true]);
		expect(node.description.inputs).toEqual([]);
		expect(node.description.webhooks).toEqual([{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }]);
	});
});
