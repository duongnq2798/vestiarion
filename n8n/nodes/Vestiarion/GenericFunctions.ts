import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/** The most a list page holds, as the API allows. */
export const PAGE_SIZE_MAX = 200;

type Context = IExecuteFunctions | ILoadOptionsFunctions;

export interface Page {
	data: IDataObject[];
	page: { nextCursor: string | null; hasMore: boolean; count: number };
}

/**
 * The API's origin from the credential, without a trailing slash. Plain http is refused, except to this machine, so the
 * key never crosses a network in the clear (n8n N4).
 */
async function baseUrl(context: Context): Promise<string> {
	const credentials = await context.getCredentials('vestiarionApi');
	const url = (typeof credentials.baseUrl === 'string' && credentials.baseUrl.trim() !== '' ? credentials.baseUrl.trim() : 'https://www.vestiarion.xyz').replace(/\/+$/, '');
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new NodeOperationError(context.getNode(), `The credential's Base URL is not a URL: ${url}`);
	}
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
		throw new NodeOperationError(context.getNode(), 'The credential\'s Base URL must be https, so the API key is never sent in the clear', {
			description: 'Plain http is accepted only for localhost, for your own deployment on this machine.',
		});
	}
	return url;
}

/**
 * One request to the workspace's API with the credential's key. A status that is not 2xx becomes a NodeApiError
 * carrying the API's own message and code, as `{ error: { code, message } }` gives them, and its Retry-After.
 */
export async function vestiarionRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	options: { qs?: IDataObject; body?: IDataObject; headers?: IDataObject; itemIndex?: number } = {},
): Promise<IDataObject> {
	const request: IHttpRequestOptions = {
		method,
		url: `${await baseUrl(this)}${path}`,
		qs: options.qs,
		body: options.body,
		headers: { Accept: 'application/json', ...options.headers },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'vestiarionApi', request)) as {
		statusCode: number;
		headers: IDataObject;
		body: unknown;
	};
	const body = (typeof response.body === 'object' && response.body !== null ? response.body : {}) as IDataObject;
	if (response.statusCode >= 200 && response.statusCode < 300) return body;

	const error = (typeof body.error === 'object' && body.error !== null ? body.error : {}) as IDataObject;
	const code = typeof error.code === 'string' ? error.code : 'error';
	const message = typeof error.message === 'string' ? error.message : `The API answered ${response.statusCode}.`;
	const retryAfter = response.headers?.['retry-after'];
	throw new NodeApiError(this.getNode(), body as JsonObject, {
		message,
		description: `HTTP ${response.statusCode} ${code}${retryAfter !== undefined ? `. Retry after ${String(retryAfter)} s.` : '.'}`,
		httpCode: String(response.statusCode),
		itemIndex: options.itemIndex,
	});
}

/**
 * A list's records, page by page from `cursor`: every one with `returnAll`, else at most `limit`. A cursor the API
 * gave before ends the reading, so a loop in the paging can never run forever.
 */
export async function vestiarionList(
	this: Context,
	path: string,
	qs: IDataObject,
	options: { returnAll: boolean; limit: number; cursor?: string; itemIndex?: number },
): Promise<IDataObject[]> {
	const records: IDataObject[] = [];
	const seen = new Set<string>();
	let cursor = options.cursor && options.cursor.trim() !== '' ? options.cursor.trim() : undefined;
	for (;;) {
		const wanted = options.returnAll ? PAGE_SIZE_MAX : Math.min(PAGE_SIZE_MAX, options.limit - records.length);
		const answer = (await vestiarionRequest.call(this, 'GET', path, {
			qs: { ...qs, limit: wanted, ...(cursor ? { cursor } : {}) },
			itemIndex: options.itemIndex,
		})) as unknown as Page;
		records.push(...(Array.isArray(answer.data) ? answer.data : []));
		const next = answer.page?.nextCursor;
		if (!answer.page?.hasMore || !next || seen.has(next)) break;
		if (!options.returnAll && records.length >= options.limit) break;
		seen.add(next);
		cursor = next;
	}
	return options.returnAll ? records : records.slice(0, options.limit);
}

/**
 * A day as the API takes one, `YYYY-MM-DD`, from what a date field gives: a string such as
 * `2026-10-31T00:00:00.000+02:00`, a Luxon DateTime, as an expression like `{{ $now.plus({ days: 30 }) }}` gives, in its
 * own zone, or a JavaScript Date, read in the workflow's time zone. Null when it is not a day.
 */
export function dayOf(value: unknown, timeZone: string): string | null {
	let text: unknown = value;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		// en-CA writes a date as YYYY-MM-DD.
		text = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
	} else if (typeof value === 'object' && value !== null && typeof (value as { toISODate?: unknown }).toISODate === 'function') {
		text = (value as { toISODate: () => string | null }).toISODate();
	}
	if (typeof text !== 'string') return null;
	const day = text.trim().slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}
