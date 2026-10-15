import { getAuth, refresh, validAuth } from "./auth.js";
import { API_BASE } from "./config.js";

/**
 * The draft endpoints, the only part of Vestiarion the extension's token opens: capture, read, edit and send a draft.
 * Nothing here can add a bill, approve or pay.
 */

const DRAFTS = `${API_BASE}/api/extension/v1/invoice-drafts`;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const OFFLINE = "Vestiarion could not be reached. Check your connection and try again.";

/**
 * Why a call cannot go on without a token: the connection ended (the refresh was refused, and the tokens forgotten), or
 * Vestiarion did not answer the refresh, when the tokens are still kept for the next try.
 */
async function withoutToken(ended) {
  if (await getAuth()) return new ApiError(0, "offline", OFFLINE);
  return new ApiError(401, "unauthorized", ended);
}

async function call(url, init, retried = false) {
  const auth = await validAuth();
  if (!auth) throw await withoutToken("Connect Vestiarion first.");
  let response;
  try {
    response = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${auth.accessToken}` } });
  } catch {
    throw new ApiError(0, "offline", OFFLINE);
  }
  if (response.status === 401 && !retried) {
    if (await refresh()) return call(url, init, true);
    throw await withoutToken("This connection has ended. Connect Vestiarion again.");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? "error", body?.error?.message ?? "Vestiarion did not answer. Try again in a moment.");
  }
  return body;
}

export async function session() {
  return (await call(`${API_BASE}/api/extension/v1/session`, { method: "GET" })).data;
}

export async function captureSelection(text, idempotencyKey) {
  const body = await call(DRAFTS, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ source: "selection", text }),
  });
  return body.data;
}

export async function captureFile(file, idempotencyKey) {
  const form = new FormData();
  form.append("file", file, file.name);
  const body = await call(DRAFTS, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: form });
  return body.data;
}

export async function getDraft(id) {
  return (await call(`${DRAFTS}/${encodeURIComponent(id)}`, { method: "GET" })).data;
}

export async function saveDraft(id, fields) {
  const body = await call(`${DRAFTS}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return body.data;
}

export async function sendDraft(id) {
  return (await call(`${DRAFTS}/${encodeURIComponent(id)}/send`, { method: "POST" })).data;
}
