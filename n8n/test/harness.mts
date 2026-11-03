import { readFileSync } from 'node:fs';
import type { IDataObject, IHttpRequestOptions, INode } from 'n8n-workflow';

/**
 * Stand-ins for the `this` n8n gives a node: the parameters, the credential, and a recorded API that answers from the
 * repository's built examples (content/docs/examples), the shapes the API and its docs are held to.
 */

export const NODE: INode = {
	id: 'node-1',
	name: 'Vestiarion',
	type: '@vestiarion/n8n-nodes-vestiarion.vestiarion',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export const CREDENTIALS = { apiKey: 'vxk_abcdefgh_test', baseUrl: 'https://www.vestiarion.xyz/', webhookSecret: 'whsec_test-secret' };

export function example(name: string): { data: unknown; page?: unknown } {
	return JSON.parse(readFileSync(new URL(`../../content/docs/examples/${name}.json`, import.meta.url), 'utf8'));
}

type Answer = { statusCode: number; body: unknown; headers?: IDataObject };
export type Route = Answer | ((request: IHttpRequestOptions) => Answer);

/** A recorded API: answers by `METHOD /path`; anything else answers 404 in the API's shape. */
export function api(routes: Record<string, Route>) {
	const sent: Array<{ credential: string; request: IHttpRequestOptions }> = [];
	async function httpRequestWithAuthentication(this: unknown, credential: string, request: IHttpRequestOptions) {
		sent.push({ credential, request });
		const url = new URL(request.url);
		const route = routes[`${request.method} ${url.pathname}`];
		const answer = route === undefined ? { statusCode: 404, body: { error: { code: 'not_found', message: 'Not found.' } } } : typeof route === 'function' ? route(request) : route;
		return { statusCode: answer.statusCode, headers: answer.headers ?? {}, body: answer.body };
	}
	return { sent, httpRequestWithAuthentication };
}

/** An IExecuteFunctions for one run: each item's parameters, by name. */
export function executeContext(items: Array<Record<string, unknown>>, transport: ReturnType<typeof api>, options: { continueOnFail?: boolean } = {}) {
	return {
		getInputData: () => items.map(() => ({ json: {} })),
		getNodeParameter(name: string, index: number, fallback?: unknown, extra?: { extractValue?: boolean }) {
			const value = name in items[index] ? items[index][name] : fallback;
			if (extra?.extractValue && typeof value === 'object' && value !== null && 'value' in value) return (value as { value: unknown }).value;
			return value;
		},
		getCredentials: async () => CREDENTIALS,
		getNode: () => NODE,
		continueOnFail: () => options.continueOnFail === true,
		helpers: { httpRequestWithAuthentication: transport.httpRequestWithAuthentication },
	};
}
