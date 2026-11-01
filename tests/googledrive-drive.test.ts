import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { downloadFile, listFolder, readFolder } from "@/lib/googledrive/drive";
import { folderIdOf, folderUrl } from "@/lib/googledrive/link";
import { googleDriveProvider } from "@/lib/googledrive/provider";
import { DriveAccessError, driveSession, needsReconnect } from "@/lib/googledrive/session";
import { GoogleError, type GoogleHttp } from "@/lib/googlesheets/http";
import { driveError, fakeDrive, type FakeDrive } from "./support/fake-google-drive";

/**
 * The Drive reads of Google Drive intake (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD4, GD6,
 * GD13) against a fake Drive that answers as Drive's v3 API does: the pasted link read for its folder id only, never
 * opened; a folder read; its own files listed page by page, newest first, from a shared drive too; a download held to
 * 4 MB while it streams; and Drive's refusals told apart by its reason code: a 401 refreshed once, a grant Google no
 * longer takes, a missing permission, a file gone or not this app's to open, and rate limits waited out once.
 */

const SETTINGS = { clientId: "1234567890-abc123def456.apps.googleusercontent.com", clientSecret: "GOCSPX-the-drive-secret" };
const NOW = Date.parse("2026-11-01T09:00:00Z");
const FOLDER = "1FoLdErAbCdEfGhIjKlMnOpQrStUvWxYz";
const MB = 1_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function folderWith(drive: FakeDrive, count: number, at = "2026-10-01T00:00:00.000Z") {
  drive.add({ id: FOLDER, name: "Bills to pay", mimeType: "application/vnd.google-apps.folder", parents: ["root"], createdTime: "2026-09-01T00:00:00.000Z" });
  for (let index = 0; index < count; index += 1) {
    drive.add({
      id: `1File${String(index).padStart(28, "0")}`,
      name: `inv-${index}.pdf`,
      mimeType: "application/pdf",
      parents: [FOLDER],
      createdTime: new Date(Date.parse(at) + index * 60_000).toISOString(),
      bytes: new TextEncoder().encode(`%PDF-1.4 ${index}`),
    });
  }
}

const http = (drive: FakeDrive, extra: GoogleHttp = {}): GoogleHttp => ({ fetchImpl: drive.fetch, now: () => NOW, sleep: async () => {}, logAs: "google drive", ...extra });

describe("the folder a person names (Google Drive intake GD4)", () => {
  it("reads the id from Drive's folder links, with /u/<n>/ and a query, or the id itself", () => {
    expect(folderIdOf(`https://drive.google.com/drive/folders/${FOLDER}`)).toBe(FOLDER);
    expect(folderIdOf(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`)).toBe(FOLDER);
    expect(folderIdOf(`https://drive.google.com/drive/u/1/folders/${FOLDER}?usp=drive_link`)).toBe(FOLDER);
    expect(folderIdOf(`https://drive.google.com/drive/folders/${FOLDER}/`)).toBe(FOLDER);
    expect(folderIdOf(`drive.google.com/drive/folders/${FOLDER}#section`)).toBe(FOLDER);
    expect(folderIdOf(`  ${FOLDER}  `)).toBe(FOLDER);
    // A shared drive's own root.
    expect(folderIdOf("https://drive.google.com/drive/folders/0AbCdEfGhIjKlUk9PVA")).toBe("0AbCdEfGhIjKlUk9PVA");
  });

  it("takes nothing else: a file's link, another host, My Drive, a path that is not a folder's", () => {
    expect(folderIdOf(`https://drive.google.com/file/d/${FOLDER}/view?usp=sharing`)).toBeNull();
    expect(folderIdOf(`https://docs.google.com/document/d/${FOLDER}/edit`)).toBeNull();
    expect(folderIdOf(`https://drive.google.com.evil.example/drive/folders/${FOLDER}`)).toBeNull();
    expect(folderIdOf(`https://user:pass@drive.google.com/drive/folders/${FOLDER}`)).toBeNull();
    expect(folderIdOf("https://drive.google.com/drive/my-drive")).toBeNull();
    expect(folderIdOf(`https://drive.google.com/drive/folders/${FOLDER}/../x`)).toBeNull();
    expect(folderIdOf(`ftp://drive.google.com/drive/folders/${FOLDER}`)).toBeNull();
    expect(folderIdOf("short")).toBeNull();
    expect(folderIdOf("")).toBeNull();
    expect(folderUrl(FOLDER)).toBe(`https://drive.google.com/drive/folders/${FOLDER}`);
  });

  it("is never fetched: parsing a link sends nothing", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    folderIdOf(`https://drive.google.com/drive/folders/${FOLDER}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("readFolder (GD4, GD13)", () => {
  it("reads the folder's name, type, trash and shared drive, from a shared drive too", async () => {
    const drive = fakeDrive();
    drive.add({ id: FOLDER, name: "Bills to pay", mimeType: "application/vnd.google-apps.folder", parents: ["0AbCdEfGhIjKlUk9PVA"], driveId: "0AbCdEfGhIjKlUk9PVA", createdTime: "2026-09-01T00:00:00Z" });
    expect(await readFolder(drive.accessToken, FOLDER, http(drive))).toEqual({
      id: FOLDER,
      name: "Bills to pay",
      mimeType: "application/vnd.google-apps.folder",
      trashed: false,
      driveId: "0AbCdEfGhIjKlUk9PVA",
    });
    const sent = drive.requests[0].url;
    expect(`${sent.origin}${sent.pathname}`).toBe(`https://www.googleapis.com/drive/v3/files/${FOLDER}`);
    expect(Object.fromEntries(sent.searchParams)).toEqual({ fields: "id, name, mimeType, trashed, driveId", supportsAllDrives: "true" });
  });

  it("is gone for a 404, and keeps Drive's reason for a folder this app may not open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const drive = fakeDrive();
    await expect(readFolder(drive.accessToken, FOLDER, http(drive))).rejects.toMatchObject({ failure: "gone", reason: "notFound" });
    drive.notAuthorized.add(FOLDER);
    await expect(readFolder(drive.accessToken, FOLDER, http(drive))).rejects.toMatchObject({ failure: "forbidden", reason: "appNotAuthorizedToFile" });
  });

  it("refuses an id that is not one before any call", async () => {
    const drive = fakeDrive();
    await expect(readFolder(drive.accessToken, "../../about", http(drive))).rejects.toBeInstanceOf(GoogleError);
    expect(drive.requests).toEqual([]);
  });
});

describe("listFolder (GD5, GD6)", () => {
  it("asks Drive for the folder's own files, not its subfolders nor the trash, newest first, from shared drives too", async () => {
    const drive = fakeDrive();
    folderWith(drive, 3);
    drive.add({ id: "1SubFolderAbCdEfGhIjKlMnOpQrStUv", name: "Paid", mimeType: "application/vnd.google-apps.folder", parents: [FOLDER], createdTime: "2026-10-09T00:00:00Z" });
    drive.add({ id: "1TrashedAbCdEfGhIjKlMnOpQrStUvW", name: "old.pdf", mimeType: "application/pdf", parents: [FOLDER], trashed: true, createdTime: "2026-10-09T00:00:00Z" });
    const listed = await listFolder(drive.accessToken, FOLDER, { max: 2000 }, http(drive));
    expect(listed.more).toBe(false);
    expect(listed.files.map((file) => file.name)).toEqual(["inv-2.pdf", "inv-1.pdf", "inv-0.pdf"]);
    expect(listed.files[0]).toEqual({
      id: `1File${"2".padStart(28, "0")}`,
      name: "inv-2.pdf",
      mimeType: "application/pdf",
      size: 10,
      md5Checksum: "0".repeat(32),
      createdTime: "2026-10-01T00:02:00.000Z",
      modifiedTime: "2026-10-01T00:02:00.000Z",
      lastModifyingUser: null,
    });
    const params = Object.fromEntries(drive.requests[0].url.searchParams);
    expect(params).toEqual({
      q: `'${FOLDER}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum, createdTime, modifiedTime, lastModifyingUser(displayName, emailAddress))",
      orderBy: "createdTime desc",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
  });

  it("follows Drive's pages, even short ones, and says when a folder holds more than asked", async () => {
    const drive = fakeDrive();
    folderWith(drive, 25);
    drive.servedPageSize = 10;
    const all = await listFolder(drive.accessToken, FOLDER, { max: 1000 }, http(drive));
    expect(all.files).toHaveLength(25);
    expect(all.more).toBe(false);
    expect(drive.requests.map((one) => one.url.searchParams.get("pageToken"))).toEqual([null, "page-10", "page-20"]);

    const capped = await listFolder(drive.accessToken, FOLDER, { max: 12 }, http(drive));
    expect(capped).toMatchObject({ more: true });
    expect(capped.files).toHaveLength(12);
  });

  it("refuses a folder of 1,001 files and takes one of exactly 1,000 (GD5)", async () => {
    const drive = fakeDrive();
    folderWith(drive, 1000);
    expect(await listFolder(drive.accessToken, FOLDER, { max: 1000 }, http(drive))).toMatchObject({ more: false });
    drive.add({ id: "1OneMoreAbCdEfGhIjKlMnOpQrStUvWx", name: "one-more.pdf", mimeType: "application/pdf", parents: [FOLDER], createdTime: "2026-10-20T00:00:00Z" });
    expect(await listFolder(drive.accessToken, FOLDER, { max: 1000 }, http(drive))).toMatchObject({ more: true });
  });

  it("keeps a file's size as a number, none for a Google Docs file, and drops an entry whose id does not read", async () => {
    const drive = fakeDrive();
    folderWith(drive, 0);
    drive.add({ id: "1DocAbCdEfGhIjKlMnOpQrStUvWxYz01", name: "Invoice draft", mimeType: "application/vnd.google-apps.document", parents: [FOLDER], createdTime: "2026-10-02T00:00:00Z" });
    drive.queued.push(() =>
      new Response(JSON.stringify({ files: [{ id: "../x", name: "bad.pdf", mimeType: "application/pdf" }, { id: "1DocAbCdEfGhIjKlMnOpQrStUvWxYz01", name: "Invoice draft", mimeType: "application/vnd.google-apps.document" }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    const listed = await listFolder(drive.accessToken, FOLDER, { max: 2000 }, http(drive));
    expect(listed.files.map((file) => [file.id, file.size])).toEqual([["1DocAbCdEfGhIjKlMnOpQrStUvWxYz01", null]]);
  });
});

describe("downloadFile (GD6)", () => {
  it("downloads a file's bytes with alt=media, from a shared drive too", async () => {
    const drive = fakeDrive();
    folderWith(drive, 1);
    const id = `1File${"0".padStart(28, "0")}`;
    const got = await downloadFile(drive.accessToken, id, 4 * MB, http(drive));
    expect(got).toEqual({ ok: true, bytes: new TextEncoder().encode("%PDF-1.4 0"), contentType: "application/pdf" });
    expect(Object.fromEntries(drive.requests[0].url.searchParams)).toEqual({ alt: "media", supportsAllDrives: "true" });
    expect(new Headers(drive.requests[0].init.headers).get("authorization")).toBe(`Bearer ${drive.accessToken}`);
  });

  it("stops at 4 MB while the body streams, when Drive says no length or a false one", async () => {
    const big = new Uint8Array(4 * MB + 1);
    const chunks = (bytes: Uint8Array) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += 64_000) controller.enqueue(bytes.slice(at, at + 64_000));
          controller.close();
        },
      });
    let pulled = 0;
    const counting = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1_000_000));
        if (pulled > 100) controller.close();
      },
    });
    const drive = fakeDrive();
    drive.queued.push(() => new Response(chunks(big), { headers: { "content-type": "application/pdf" } }));
    expect(await downloadFile(drive.accessToken, "1BigAbCdEfGhIjKlMnOpQrStUvWxYz012", 4 * MB, http(drive))).toEqual({ ok: false, reason: "too_large" });
    drive.queued.push(() => new Response(counting, { headers: { "content-type": "application/pdf", "content-length": "1000" } }));
    expect(await downloadFile(drive.accessToken, "1LiarAbCdEfGhIjKlMnOpQrStUvWxYz01", 4 * MB, http(drive))).toEqual({ ok: false, reason: "too_large" });
    // It stopped reading as soon as it passed 4 MB, never pulling the rest.
    expect(pulled).toBeLessThanOrEqual(6);
    drive.queued.push(() => new Response(new Uint8Array(10), { headers: { "content-type": "application/pdf", "content-length": String(5 * MB) } }));
    expect(await downloadFile(drive.accessToken, "1LongAbCdEfGhIjKlMnOpQrStUvWxYz01", 4 * MB, http(drive))).toEqual({ ok: false, reason: "too_large" });
  });

  it("is refused for a Google Docs file, which has no bytes, and gone for a file no longer there", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const drive = fakeDrive();
    folderWith(drive, 0);
    drive.add({ id: "1DocAbCdEfGhIjKlMnOpQrStUvWxYz01", name: "Invoice draft", mimeType: "application/vnd.google-apps.document", parents: [FOLDER], createdTime: "2026-10-02T00:00:00Z" });
    await expect(downloadFile(drive.accessToken, "1DocAbCdEfGhIjKlMnOpQrStUvWxYz01", 4 * MB, http(drive))).rejects.toMatchObject({ failure: "forbidden", reason: "fileNotDownloadable" });
    await expect(downloadFile(drive.accessToken, "1GoneAbCdEfGhIjKlMnOpQrStUvWxYz01", 4 * MB, http(drive))).rejects.toMatchObject({ failure: "gone" });
  });
});

describe("Drive's refusals (GD13)", () => {
  it("waits out a short rate limit once and tries again; a long one, or a second, is the caller's", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const drive = fakeDrive();
    folderWith(drive, 1);
    const slept: number[] = [];
    const waits = http(drive, { sleep: async (ms) => void slept.push(ms) });
    drive.queued.push(() => driveError(403, "userRateLimitExceeded", "User Rate Limit Exceeded"));
    // A 403 userRateLimitExceeded names no wait: 30 seconds, longer than a call waits, so it is the caller's to back off.
    await expect(readFolder(drive.accessToken, FOLDER, waits)).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 30_000 });
    drive.queued.push(() => new Response(JSON.stringify({ error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded", domain: "usageLimits", message: "Rate Limit Exceeded" }] } }), { status: 429, headers: { "retry-after": "2" } }));
    expect(await readFolder(drive.accessToken, FOLDER, waits)).toMatchObject({ id: FOLDER });
    expect(slept).toEqual([2000]);
    expect(logged).toHaveBeenCalledWith("google drive: files.get answered 429 rateLimitExceeded");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("Rate Limit Exceeded");
  });

  it("asks for a reconnect when the grant lacks Drive's permission", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const drive = fakeDrive();
    folderWith(drive, 1);
    drive.scopeMissing = true;
    await expect(listFolder(drive.accessToken, FOLDER, { max: 10 }, http(drive))).rejects.toMatchObject({ failure: "reconnect" });
  });
});

/** The connection's token row, in memory: the refresh lease and the version as the core keeps them. */
function tokenStore(drive: FakeDrive, expiresAt = NOW + 3_000_000): TokenStore & { row: StoredTokens } {
  const store = {
    row: { id: "tok-1", version: 1, accessToken: drive.accessToken, refreshToken: "1//0g-refresh", expiresAt, scopes: ["https://www.googleapis.com/auth/drive.readonly"] } as StoredTokens,
    holder: null as string | null,
    async read() {
      return { ...store.row };
    },
    async lease(holder: string) {
      if (store.holder) return null;
      store.holder = holder;
      return { ...store.row };
    },
    async store(holder: string, version: number, tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }) {
      if (store.holder !== holder || store.row.version !== version) return false;
      store.row = { ...store.row, ...tokens, version: version + 1 };
      store.holder = null;
      return true;
    },
    async release(holder: string) {
      if (store.holder === holder) store.holder = null;
    },
  };
  return store;
}

describe("a session on the connection's token (GD13)", () => {
  it("refreshes once on a 401 and sends the call again with the new token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const drive = fakeDrive();
    folderWith(drive, 1);
    const provider = googleDriveProvider(SETTINGS, http(drive));
    const tokens = tokenStore(drive);
    // Google stopped taking the stored token before its time.
    drive.accessToken = "ya29.rotated-at-google";
    drive.refreshes = 0;
    const session = driveSession({ provider, tokens, now: () => NOW });
    const folder = await session.call((token) => readFolder(token, FOLDER, provider.http));
    expect(folder.name).toBe("Bills to pay");
    expect(drive.refreshes).toBe(1);
    expect(tokens.row.accessToken).toBe("ya29.refreshed-1");
  });

  it("asks for a reconnect when Google answers invalid_grant, or refuses the refreshed token too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const drive = fakeDrive();
    folderWith(drive, 1);
    const provider = googleDriveProvider(SETTINGS, http(drive));
    drive.accessToken = "ya29.someone-else";
    drive.grantAlive = false;
    const revoked = driveSession({ provider, tokens: tokenStore({ ...drive, accessToken: "ya29.stale" } as FakeDrive), now: () => NOW });
    const refused = await revoked.call((token) => readFolder(token, FOLDER, provider.http)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DriveAccessError);
    expect(needsReconnect(refused)).toBe(true);

    // Refreshed, then refused again: the access was removed.
    drive.grantAlive = true;
    const always401 = googleDriveProvider(SETTINGS, http(drive, { fetchImpl: async (input, init) => (String(input).includes("/token") ? drive.fetch(input, init) : driveError(401, "authError", "Invalid Credentials")) }));
    const twice = driveSession({ provider: always401, tokens: tokenStore({ ...drive, accessToken: "ya29.stale" } as FakeDrive), now: () => NOW });
    const again = await twice.call((token) => readFolder(token, FOLDER, always401.http)).catch((error: unknown) => error);
    expect(again).toMatchObject({ failure: "reconnect" });
    expect(needsReconnect(again)).toBe(true);
  });
});
