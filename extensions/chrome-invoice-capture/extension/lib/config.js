/**
 * Where the extension sends what a person captures: Vestiarion itself, and nowhere else. It is the only host the
 * manifest asks for. A developer running Vestiarion locally may point this at their own server while testing an
 * unpacked build; the server answers only the extensions its CHROME_EXTENSION_IDS allows.
 */
export const API_BASE = "https://www.vestiarion.xyz";

/** All the extension asks for: create drafts, and read the drafts it created. */
export const SCOPE = "invoice_draft:create invoice_draft:read";

/** The most text one capture sends, the reader's own limit. */
export const MAX_SELECTION_CHARS = 20000;

/** The largest file one capture sends, the reader's own limit. */
export const MAX_FILE_BYTES = 4000000;
