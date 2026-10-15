import downloadKey from "./download-key.json";

/**
 * Which Chrome extensions may connect to this deployment, and what they may be granted (invoice capture design C12,
 * C15, C21). Pure: read from `CHROME_EXTENSION_IDS`, the extension ids separated by commas or spaces, such as the Web
 * Store's and an unpacked build's. Without one valid id, invoice capture is off: the authorize page says so and every
 * extension route answers 503. Once it is on, the copy offered for download is allowed too (`DOWNLOAD_EXTENSION_ID`).
 */

/** The one audience an extension's token is for: the extension endpoints, never `/api/v1` (C15, C16). */
export const EXTENSION_AUDIENCE = "vestiarion-chrome";

/** Everything an extension can be granted: create drafts, and read the drafts it created (C15). */
export const EXTENSION_SCOPES = ["invoice_draft:create", "invoice_draft:read"] as const;
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

/** A Chrome extension's id: 32 letters from a to p. */
const EXTENSION_ID = /^[a-p]{32}$/;

export interface ExtensionSettings {
  /** The extension ids allowed to connect. */
  ids: string[];
}

export function isExtensionId(value: unknown): value is string {
  return typeof value === "string" && EXTENSION_ID.test(value);
}

/** The ids in the variable that are extension ids, once each; anything else in it is ignored. */
export function parseExtensionIds(raw: string | undefined): string[] {
  const ids = (raw ?? "").split(/[\s,]+/).map((id) => id.trim()).filter(isExtensionId);
  return [...new Set(ids)];
}

/**
 * The ID of the copy of Vestiarion Invoice Capture offered for download (`/downloads/vestiarion-invoice-capture.zip`,
 * built by `scripts/build-extension-download.mjs`). An unpacked extension's ID is otherwise worked out from the folder
 * it is loaded from, so each copy would have its own; the download's manifest carries the public key in
 * `download-key.json`, which gives every copy this one ID. An ID names a client, as the Web Store's does: connecting
 * still takes the person's sign-in and their Allow, and its tokens open only its own drafts.
 */
export const DOWNLOAD_EXTENSION_ID: string = downloadKey.id;

/** The settings, or null when no extension may connect: the ids listed, and the download's once any is. */
export function extensionSettingsFromEnv(raw: string | undefined = process.env.CHROME_EXTENSION_IDS): ExtensionSettings | null {
  const ids = parseExtensionIds(raw);
  return ids.length > 0 ? { ids: [...new Set([...ids, DOWNLOAD_EXTENSION_ID])] } : null;
}

/** The one redirect an extension's code may go to: what `chrome.identity.getRedirectURL()` returns for it. */
export function redirectUriFor(clientId: string): string {
  return `https://${clientId}.chromiumapp.org/`;
}

/** Whether this client may connect, and send its code back to exactly this address (C12). */
export function allowedClient(settings: ExtensionSettings, clientId: unknown, redirectUri: unknown): clientId is string {
  return isExtensionId(clientId) && settings.ids.includes(clientId) && redirectUri === redirectUriFor(clientId);
}

/** An origin a browser sends for an allowed extension's pages: `chrome-extension://<id>` (C21). */
export function allowedOrigin(settings: ExtensionSettings, origin: string | null): boolean {
  if (!origin) return false;
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return match !== null && settings.ids.includes(match[1]);
}

/**
 * The scopes asked for, space-separated as OAuth writes them; all of them when none is named. Null when one is not
 * an extension's, so the request is refused rather than granted less than it asked for silently (C15).
 */
export function parseScopes(raw: string | null | undefined): ExtensionScope[] | null {
  const asked = (raw ?? "").split(" ").filter(Boolean);
  if (asked.length === 0) return [...EXTENSION_SCOPES];
  if (!asked.every((scope): scope is ExtensionScope => (EXTENSION_SCOPES as readonly string[]).includes(scope))) return null;
  return EXTENSION_SCOPES.filter((scope) => asked.includes(scope));
}

export function scopeString(scopes: readonly ExtensionScope[]): string {
  return EXTENSION_SCOPES.filter((scope) => scopes.includes(scope)).join(" ");
}
