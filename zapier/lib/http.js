'use strict';

/**
 * How every request reaches the workspace's API (docs/superpowers/specs/2026-11-06-zapier-integration-design.md Z3):
 * the Base URL from the connection, the key as a bearer token, and the API's errors as Zapier's.
 */

const DEFAULT_BASE_URL = 'https://www.vestiarion.xyz';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API's origin from the connection, without a trailing slash. Plain http is refused, except to this machine, so
 * the key never crosses a network in the clear (Zapier Z3).
 */
function baseUrl(z, bundle) {
  const given = String((bundle.authData && bundle.authData.baseUrl) || '').trim();
  const url = (given || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new z.errors.Error(`The connection's Base URL is not a URL: ${url}`, 'InvalidBaseUrl', 400);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname))) {
    throw new z.errors.Error(
      "The connection's Base URL must be https, so the API key is never sent in the clear. Plain http works only for localhost.",
      'InsecureBaseUrl',
      400,
    );
  }
  return url;
}

/** Sends the connection's key with every request (Zapier Z3). */
function addApiKey(request, z, bundle) {
  const key = String((bundle.authData && bundle.authData.apiKey) || '').trim();
  request.headers = { Accept: 'application/json', ...request.headers };
  if (key) request.headers.Authorization = `Bearer ${key}`;
  return request;
}

/**
 * The API's errors as Zapier's: a 401 asks the user to reconnect, a 429 is throttled for its Retry-After, and any other
 * error keeps the API's own message and code, as `{ error: { code, message } }` gives them (Zapier Z3).
 */
function handleErrors(response, z) {
  if (response.status >= 200 && response.status < 300) return response;
  let body = {};
  try {
    body = typeof response.json === 'object' && response.json !== null ? response.json : JSON.parse(response.content || '{}');
  } catch {
    body = {};
  }
  const error = body && typeof body.error === 'object' && body.error !== null ? body.error : {};
  const code = typeof error.code === 'string' ? error.code : 'error';
  const message = typeof error.message === 'string' ? error.message : `The Vestiarion API answered ${response.status}.`;
  if (response.status === 401) {
    throw new z.errors.RefreshAuthError(`${message} Reconnect Vestiarion with a current API key.`);
  }
  if (response.status === 429) {
    const after = Number(response.getHeader('retry-after'));
    throw new z.errors.ThrottledError(message, Number.isFinite(after) && after > 0 ? after : 60);
  }
  throw new z.errors.Error(message, code, response.status);
}

/** One request to the workspace's API; `path` starts with `/api/v1`. */
async function vestiarion(z, bundle, { method = 'GET', path, params, body, headers }) {
  const response = await z.request({
    method,
    url: `${baseUrl(z, bundle)}${path}`,
    params,
    body,
    headers,
    // Errors are read by handleErrors, which runs after every response.
    skipThrowForStatus: true,
  });
  return response.data;
}

module.exports = { DEFAULT_BASE_URL, baseUrl, addApiKey, handleErrors, vestiarion };
