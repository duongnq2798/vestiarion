/**
 * Google Drive's API v3 and Google's token endpoint as the Google Drive intake reads them
 * (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md, "Google facts"), in memory: `files.get` on a file or
 * folder, `files.list` of one folder's children with Drive's own query, fields, ordering and paging, `alt=media`
 * downloads, `about`, and refreshing a token. It answers as Drive does, with Drive's JSON and its error bodies (a 401
 * for a token it no longer takes, `notFound` 404s, 403 `insufficientPermissions`, `appNotAuthorizedToFile`,
 * `fileNotDownloadable`, `userRateLimitExceeded`, 429 `rateLimitExceeded`), refuses a request shaped otherwise with a 400,
 * and records every request it was sent.
 */

export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed?: boolean;
  driveId?: string;
  createdTime: string;
  modifiedTime?: string;
  /** The bytes a download answers; a Google Docs file has none. */
  bytes?: Uint8Array;
  lastModifyingUser?: { displayName: string; emailAddress?: string };
}

const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const LIST_FIELDS = "nextPageToken, files(id, name, mimeType, size, md5Checksum, createdTime, modifiedTime, lastModifyingUser(displayName, emailAddress))";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8", ...headers } });

/** Drive's error body, as its v3 API writes it. */
export function driveError(status: number, reason: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: { errors: [{ domain: reason.includes("RateLimit") ? "usageLimits" : "global", reason, message }], code: status, message, ...extra } }, status);
}

const UNAUTHENTICATED = () =>
  json(
    {
      error: {
        code: 401,
        message: "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
        errors: [{ message: "Invalid Credentials", domain: "global", reason: "authError", location: "Authorization", locationType: "header" }],
        status: "UNAUTHENTICATED",
      },
    },
    401
  );

const SCOPE_INSUFFICIENT = () =>
  json(
    {
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        errors: [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }],
        status: "PERMISSION_DENIED",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }],
      },
    },
    403
  );

export interface FakeDrive {
  files: Map<string, FakeDriveFile>;
  /** The access token Drive takes now; any other is a 401. */
  accessToken: string;
  /** Whether Google takes the refresh token: false answers a refresh with `invalid_grant`. */
  grantAlive: boolean;
  /** Ids the connected account cannot open: a 404 as for a file not shared with it. */
  hidden: Set<string>;
  /** Ids whose read answers 403 `appNotAuthorizedToFile`. */
  notAuthorized: Set<string>;
  /** The next calls to Drive's API answer this, then the queue empties. */
  queued: Array<() => Response>;
  /** The grant lacks Drive's permission: every API call is a 403 `insufficientPermissions`. */
  scopeMissing: boolean;
  /** Drive's own page size at most, even when asked for more. */
  servedPageSize: number;
  refreshes: number;
  requests: Array<{ url: URL; init: RequestInit }>;
  fetch: typeof fetch;
  add(file: FakeDriveFile): FakeDriveFile;
}

const PDF = new TextEncoder().encode("%PDF-1.4");

export function fakeDrive(options: { accessToken?: string } = {}): FakeDrive {
  const drive: FakeDrive = {
    files: new Map(),
    accessToken: options.accessToken ?? "ya29.live-access",
    grantAlive: true,
    hidden: new Set(),
    notAuthorized: new Set(),
    queued: [],
    scopeMissing: false,
    servedPageSize: 1000,
    refreshes: 0,
    requests: [],
    fetch: undefined as unknown as typeof fetch,
    add(file) {
      drive.files.set(file.id, file);
      return file;
    },
  };

  const metadata = (file: FakeDriveFile, fields: string) => {
    const all: Record<string, unknown> = {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      trashed: file.trashed === true,
      ...(file.driveId ? { driveId: file.driveId } : {}),
      // Drive writes a size as an int64 string, and none for a Google Docs file or a folder.
      ...(file.bytes && !file.mimeType.startsWith("application/vnd.google-apps.") ? { size: String(file.bytes.length), md5Checksum: "0".repeat(32) } : {}),
      createdTime: file.createdTime,
      modifiedTime: file.modifiedTime ?? file.createdTime,
      ...(file.lastModifyingUser ? { lastModifyingUser: { ...file.lastModifyingUser } } : {}),
    };
    const wanted = fields.split(",").map((field) => field.trim().replace(/\(.*$/, ""));
    return Object.fromEntries(Object.entries(all).filter(([key]) => wanted.includes(key)));
  };

  const api = (url: URL, init: RequestInit): Response => {
    if (new Headers(init.headers).get("authorization") !== `Bearer ${drive.accessToken}`) return UNAUTHENTICATED();
    if (drive.scopeMissing) return SCOPE_INSUFFICIENT();
    const queued = drive.queued.shift();
    if (queued) return queued();
    const path = url.pathname.replace("/drive/v3", "");
    if (path === "/files") {
      const q = url.searchParams.get("q") ?? "";
      const asked = /^'([A-Za-z0-9_-]+)' in parents and trashed = false and mimeType != 'application\/vnd\.google-apps\.folder'$/.exec(q);
      if (!asked) return driveError(400, "invalid", "Invalid Value");
      if (url.searchParams.get("fields") !== LIST_FIELDS) return driveError(400, "invalid", "Invalid field selection");
      if (url.searchParams.get("supportsAllDrives") !== "true" || url.searchParams.get("includeItemsFromAllDrives") !== "true") return driveError(400, "invalid", "Shared drives not asked for");
      if (url.searchParams.get("orderBy") !== "createdTime desc") return driveError(400, "invalid", "Invalid orderBy");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "100");
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) return driveError(400, "invalid", "Invalid Value");
      const parent = asked[1];
      if (drive.hidden.has(parent) || !drive.files.has(parent)) return driveError(404, "notFound", `File not found: ${parent}.`, { locationType: "parameter", location: "fileId" });
      const children = [...drive.files.values()]
        .filter((file) => file.parents.includes(parent) && file.trashed !== true && file.mimeType !== FOLDER)
        .sort((a, b) => b.createdTime.localeCompare(a.createdTime));
      const start = Number(url.searchParams.get("pageToken")?.replace("page-", "") ?? "0");
      const take = Math.min(pageSize, drive.servedPageSize);
      const page = children.slice(start, start + take);
      const next = start + take < children.length ? `page-${start + take}` : null;
      return json({ ...(next ? { nextPageToken: next } : {}), files: page.map((file) => metadata(file, "id, name, mimeType, size, md5Checksum, createdTime, modifiedTime, lastModifyingUser")) });
    }
    const one = /^\/files\/([A-Za-z0-9_-]+)$/.exec(path);
    if (one) {
      const id = one[1];
      if (url.searchParams.get("supportsAllDrives") !== "true") return driveError(400, "invalid", "Shared drives not asked for");
      if (drive.notAuthorized.has(id)) return driveError(403, "appNotAuthorizedToFile", `The user has not granted the app 1234567890 read access to the file ${id}.`);
      const file = drive.files.get(id);
      if (!file || drive.hidden.has(id)) return driveError(404, "notFound", `File not found: ${id}.`);
      if (url.searchParams.get("alt") === "media") {
        if (file.mimeType.startsWith("application/vnd.google-apps.")) {
          return driveError(403, "fileNotDownloadable", "Only files with binary content can be downloaded. Use Export with Docs Editors files.");
        }
        const bytes = file.bytes ?? PDF;
        return new Response(new Blob([new Uint8Array(bytes)]), { status: 200, headers: { "content-type": file.mimeType, "content-length": String(bytes.length) } });
      }
      return json(metadata(file, url.searchParams.get("fields") ?? "id, name, mimeType"));
    }
    if (path === "/about") return json({ user: { kind: "drive#user", displayName: "Lan Tran", permissionId: "07623471185212345678", emailAddress: "lan@pinecrest.example" } });
    return driveError(404, "notFound", "Not Found");
  };

  drive.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    drive.requests.push({ url, init: init ?? {} });
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") !== "refresh_token") return json({ error: "unsupported_grant_type" }, 400);
      if (!drive.grantAlive) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      drive.refreshes += 1;
      drive.accessToken = `ya29.refreshed-${drive.refreshes}`;
      return json({ access_token: drive.accessToken, expires_in: 3599, scope: "https://www.googleapis.com/auth/drive.readonly", token_type: "Bearer" });
    }
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/revoke") return new Response("", { status: 200 });
    if (url.origin === DRIVE.slice(0, DRIVE.indexOf("/drive")) && url.pathname.startsWith("/drive/v3/")) return api(url, init ?? {});
    throw new TypeError(`fetch failed: ${url.origin} is not Google's`);
  }) as typeof fetch;
  return drive;
}
