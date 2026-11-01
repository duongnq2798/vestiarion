import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenStore } from "@/lib/connectors/tokens";
import { signedOrgs } from "./support/signed-org";

/**
 * Bills dropped into a Google Drive folder, end to end over the real stores (docs/superpowers/specs/2026-11-01-google-
 * drive-intake-design.md GD4-GD7, GD9, GD11-GD14): the database refuses what migrations 0068 and 0148 refuse (their
 * checks, their unique keys, an upsert's conflict key: tested on their own in tests/googledrive-migration.test.ts), and
 * Google Drive is a fake that answers as Drive's v3 API does. A folder is chosen with its baseline; each read finds the
 * files added since, gives each its row once, reads a PDF of at most 4 MB the way From a document reads one and says
 * why anything else is not read; five reads a minute, 40 seconds a read; a folder gone, a rate limit and a grant Google
 * no longer takes each say so where a person reads it; the sweeper reads it every 15 minutes; and nothing is added or
 * paid by itself.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    tokens: { current: null as TokenStore | null },
    readTokens: { left: Infinity },
    provider: { current: null as unknown },
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: vi.fn() }));
vi.mock("@/lib/usage/record", () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  takeDocumentReadToken: () => {
    if (mocks.readTokens.left <= 0) return false;
    mocks.readTokens.left -= 1;
    return true;
  },
}));
vi.mock("@/lib/connectors/token-store", async (original) => ({
  ...(await original<typeof import("@/lib/connectors/token-store")>()),
  connectionTokenStore: () => mocks.tokens.current,
}));
// The deployment's Google Drive, for the sweeper's route: the fake Drive of the test.
vi.mock("@/lib/googledrive/provider", async (original) => ({
  ...(await original<typeof import("@/lib/googledrive/provider")>()),
  googleDriveProviderFromEnv: () => mocks.provider.current,
}));

import { POST as sweepRoute } from "@/app/api/platform/accounting-sync/route";
import { sweepAccounting } from "@/lib/connectors/sweep";
import { chooseDriveFolder } from "@/lib/googledrive/folder";
import type { GoogleDriveProvider } from "@/lib/googledrive/provider";
import { DRIVE_REASONS, documentOf, FOLDER_WORDS, modifierOf } from "@/lib/googledrive/read";
import { syncGoogleDriveConnection } from "@/lib/googledrive/workspace";
import { driveError } from "./support/fake-google-drive";
import { CONNECTION, DRIVE_ORG, driveWorld, FOLDER, HOOK, INVOICE_PDF, OWNER, SCAN_PDF, START, type DriveWorld } from "./support/drive-world";

const orgs = signedOrgs();
const MB = 1_000_000;
const id = (name: string) => `1${name}${"x".repeat(Math.max(0, 32 - name.length))}`.slice(0, 33);

beforeEach(() => {
  mocks.readTokens.left = Infinity;
  vi.restoreAllMocks();
});

function world(options: { slack?: boolean } = {}): DriveWorld {
  const made = driveWorld({ orgRow: orgs.orgRow, slack: options.slack });
  mocks.tokens.current = made.tokens;
  return made;
}

const rows = (w: DriveWorld, table: string) => w.db.rows(table);
const driveRows = (w: DriveWorld) => rows(w, "inbox_emails").filter((row) => row.source === "google_drive");
const folderRow = (w: DriveWorld) => rows(w, "google_drive_folders")[0];
const connection = (w: DriveWorld) => rows(w, "accounting_connections").find((row) => row.id === CONNECTION) ?? {};
const downloads = (w: DriveWorld) => w.drive.requests.filter((request) => request.url.searchParams.get("alt") === "media").map((request) => request.url.pathname.split("/").at(-1));

async function choose(w: DriveWorld, given: string = `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`) {
  return w.run(() => chooseDriveFolder({ given, by: OWNER }, w.provider));
}
const sync = (w: DriveWorld, provider: GoogleDriveProvider = w.provider, budgetMs?: number) =>
  w.run(() => syncGoogleDriveConnection(CONNECTION, provider, { origin: "https://www.vestiarion.xyz", fetchImpl: w.slackFetch, ...(budgetMs ? { budgetMs } : {}) }));

describe("choosing the folder (Google Drive intake GD4, GD5, GD11)", () => {
  it("reads the folder once, keeps the files already in it as its baseline, never reads them, and signs the count", async () => {
    const w = world();
    w.drop({ id: id("OldPaidA"), name: "paid-september.pdf", createdTime: "2026-09-30T00:00:00.000Z" });
    w.drop({ id: id("OldPaidB"), name: "paid-august.pdf", createdTime: "2026-08-31T00:00:00.000Z" });
    const chosen = await choose(w);
    expect(chosen).toMatchObject({ ok: true, folder: { folderId: FOLDER, folderName: "Bills to pay", baseline: [id("OldPaidA"), id("OldPaidB")] } });
    expect(folderRow(w)).toMatchObject({ org_id: DRIVE_ORG, connection_id: CONNECTION, folder_id: FOLDER, folder_name: "Bills to pay", chosen_by: OWNER, baseline: [id("OldPaidA"), id("OldPaidB")] });
    expect(downloads(w)).toEqual([]);
    const [entry] = w.ledger();
    expect(entry).toMatchObject({ action: "google_drive_folder_chosen", actor: "human", domain: "ap", detail: { by: OWNER, folderId: FOLDER, folderName: "Bills to pay", baseline: 2 } });
    expect(JSON.stringify(entry.detail)).not.toContain(id("OldPaidA"));

    // The first read finds nothing new: an old bill already paid never comes back as a new one (GD5).
    expect(await sync(w)).toMatchObject({ outcome: "synced", folder: "read", counts: { listed: 2, found: 0 } });
    expect(driveRows(w)).toEqual([]);
  });

  it("refuses what is not a folder's link without calling Google, and what Drive says is no folder of this account's", async () => {
    const w = world();
    expect(await w.run(() => chooseDriveFolder({ given: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view", by: OWNER }, w.provider))).toEqual({ ok: false, reason: "not_a_link" });
    expect(w.drive.requests).toEqual([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pdf = w.drop({ id: id("NotAFolder"), name: "inv.pdf" });
    expect(await choose(w, pdf.id)).toMatchObject({ ok: false, reason: "not_a_folder" });
    w.drive.add({ id: id("TrashedFolder"), name: "Old bills", mimeType: "application/vnd.google-apps.folder", parents: ["root"], trashed: true, createdTime: "2026-09-01T00:00:00Z" });
    expect(await choose(w, id("TrashedFolder"))).toMatchObject({ ok: false, reason: "trashed" });
    expect(await choose(w, id("NobodyShared"))).toMatchObject({ ok: false, reason: "not_found", account: "la***@pinecrest.example" });
    w.drive.notAuthorized.add(id("NotThisApps"));
    expect(await choose(w, id("NotThisApps"))).toMatchObject({ ok: false, reason: "not_found" });
    expect(rows(w, "google_drive_folders")).toEqual([]);
    expect(w.ledger()).toEqual([]);
  });

  it("refuses a folder holding more than 1,000 files, keeping nothing (GD5)", async () => {
    const w = world();
    for (let index = 0; index < 1001; index += 1) w.drop({ id: `1Many${String(index).padStart(28, "0")}`, name: `old-${index}.pdf`, createdTime: new Date(START - index * 60_000).toISOString() });
    expect(await choose(w)).toMatchObject({ ok: false, reason: "too_many" });
    expect(rows(w, "google_drive_folders")).toEqual([]);
  });

  it("replaces an earlier folder with the new one and its own baseline, its last read and error cleared", async () => {
    const w = world();
    await choose(w);
    folderRow(w).last_read_at = "2026-11-01T08:30:00.000Z";
    folderRow(w).last_error = FOLDER_WORDS.unavailable;
    folderRow(w).last_error_kind = "unavailable";
    const other = id("OtherFolder");
    w.drive.add({ id: other, name: "Supplier invoices", mimeType: "application/vnd.google-apps.folder", parents: ["root"], createdTime: "2026-09-01T00:00:00Z" });
    w.drop({ id: id("InOther"), name: "in-other.pdf", parents: [other] });
    expect(await choose(w, `https://drive.google.com/drive/u/0/folders/${other}`)).toMatchObject({ ok: true });
    expect(rows(w, "google_drive_folders")).toHaveLength(1);
    expect(folderRow(w)).toMatchObject({ folder_id: other, folder_name: "Supplier invoices", baseline: [id("InOther")], last_read_at: null, last_error: null, last_error_kind: null });
  });

  it("marks the connection to reconnect when Google no longer takes the grant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world();
    w.tokens.row = { ...w.tokens.row, expiresAt: START - 1 };
    w.drive.grantAlive = false;
    expect(await choose(w)).toMatchObject({ ok: false, reason: "reconnect" });
    expect(connection(w)).toMatchObject({ status: "needs_reconnect" });
    expect(String(connection(w).last_error)).toContain("Reconnect Google Drive to go on reading the new files in its folder.");
  });
});

describe("what a new file becomes (GD6)", () => {
  it("reads a PDF, an .eml and a .txt, by name or type, of at most 4 MB, and says why anything else is not", () => {
    expect(documentOf({ name: "inv.pdf", mimeType: "application/octet-stream", size: 10 })).toEqual({ read: true });
    expect(documentOf({ name: "Invoice", mimeType: "application/pdf", size: null })).toEqual({ read: true });
    expect(documentOf({ name: "fwd.eml", mimeType: "message/rfc822", size: 10 })).toEqual({ read: true });
    expect(documentOf({ name: "note.txt", mimeType: "text/plain", size: 10 })).toEqual({ read: true });
    expect(documentOf({ name: "big.pdf", mimeType: "application/pdf", size: 4 * MB + 1 })).toEqual({ read: false, reason: DRIVE_REASONS.tooLarge });
    expect(documentOf({ name: "photo.jpg", mimeType: "image/jpeg", size: 10 })).toEqual({ read: false, reason: DRIVE_REASONS.image("photo.jpg") });
    expect(documentOf({ name: "scan.HEIC", mimeType: "application/octet-stream", size: 10 })).toEqual({ read: false, reason: DRIVE_REASONS.image("scan.HEIC") });
    expect(documentOf({ name: "Invoice draft", mimeType: "application/vnd.google-apps.document", size: null })).toEqual({ read: false, reason: DRIVE_REASONS.googleFile });
    expect(documentOf({ name: "Totals", mimeType: "application/vnd.google-apps.spreadsheet", size: null })).toEqual({ read: false, reason: DRIVE_REASONS.googleFile });
    expect(documentOf({ name: "inv.pdf", mimeType: "application/vnd.google-apps.shortcut", size: null })).toEqual({ read: false, reason: DRIVE_REASONS.shortcut });
    expect(documentOf({ name: "bills.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 10 })).toEqual({ read: false, reason: DRIVE_REASONS.otherType });
    expect(DRIVE_REASONS.image("photo.jpg")).toContain("Save it as a PDF with text");
    expect(DRIVE_REASONS.googleFile).toContain("Download it as PDF into the folder");
  });

  it("keeps who last changed a file with their email masked, and nothing when Drive shows no email (GD14)", () => {
    expect(modifierOf({ lastModifyingUser: { displayName: "Lan Tran", emailAddress: "Lan@Pinecrest.example" } })).toBe("la***@pinecrest.example");
    expect(modifierOf({ lastModifyingUser: { displayName: "Lan Tran", emailAddress: null } })).toBeNull();
    expect(modifierOf({ lastModifyingUser: null })).toBeNull();
  });
});

describe("reading the folder (GD6, GD9, GD11, GD12, GD14)", () => {
  it("gives each new file its row, reads the PDF into a draft a person adds, says why the rest are not read, and adds nothing", async () => {
    const w = world();
    w.drop({ id: id("Baseline"), name: "paid.pdf", createdTime: "2026-10-01T00:00:00.000Z" });
    await choose(w);
    w.clock.now += 60_000;
    w.drop({ id: id("Northwind"), name: "northwind-inv-2207.pdf", lastModifyingUser: { displayName: "Lan Tran", emailAddress: "lan@pinecrest.example" } });
    w.drop({ id: id("Scan"), name: "scan.pdf", bytes: SCAN_PDF, createdTime: new Date(w.clock.now + 1000).toISOString() });
    w.drop({ id: id("Photo"), name: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array(2000), createdTime: new Date(w.clock.now + 2000).toISOString() });
    w.drop({ id: id("GoogleDoc"), name: "Invoice draft", mimeType: "application/vnd.google-apps.document", createdTime: new Date(w.clock.now + 3000).toISOString() });
    w.drop({ id: id("Huge"), name: "huge.pdf", bytes: new Uint8Array(4 * MB + 1), createdTime: new Date(w.clock.now + 4000).toISOString() });

    const result = await sync(w);
    expect(result).toMatchObject({ outcome: "synced", folder: "read", folderName: "Bills to pay", counts: { listed: 6, found: 5, ready: 1, needsDetails: 0, unreadable: 4, left: 0 } });
    // Only the PDFs are downloaded; the picture, the Google Docs file and the file over 4 MB never are.
    expect(downloads(w).sort()).toEqual([id("Northwind"), id("Scan")].sort());

    const byFile = new Map(driveRows(w).map((row) => [row.drive_file_id, row]));
    expect(byFile.has(id("Baseline"))).toBe(false);
    const ready = byFile.get(id("Northwind"));
    const sha256 = crypto.createHash("sha256").update(INVOICE_PDF).digest("hex");
    expect(ready).toMatchObject({
      org_id: DRIVE_ORG,
      source: "google_drive",
      file_name: "northwind-inv-2207.pdf",
      from_address: "la***@pinecrest.example",
      resend_email_id: null,
      status: "ready",
      reasons: [],
      draft: { draft: { counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", amount: "200.00", currency: "USDC" }, document: { kind: "pdf", sha256 } },
      read: { counterpartyName: "Northwind Hosting", amount: "200.00", currency: "USDC", knownSender: false, document: { kind: "pdf", sha256 } },
    });
    expect(byFile.get(id("Scan"))).toMatchObject({ status: "unreadable", reasons: [DRIVE_REASONS.scan], read: null, draft: null });
    expect(byFile.get(id("Photo"))).toMatchObject({ status: "unreadable", reasons: [DRIVE_REASONS.image("receipt.jpg")] });
    expect(byFile.get(id("GoogleDoc"))).toMatchObject({ status: "unreadable", reasons: [DRIVE_REASONS.googleFile] });
    expect(byFile.get(id("Huge"))).toMatchObject({ status: "unreadable", reasons: [DRIVE_REASONS.tooLarge] });

    // Nothing is added by itself (GD9).
    expect(rows(w, "invoices")).toEqual([]);
    const received = w.ledger().filter((entry) => entry.action === "invoice_drive_file_received");
    expect(received).toHaveLength(5);
    expect(received.find((entry) => entry.detail.driveFileId === id("Northwind"))).toMatchObject({
      actor: "system",
      domain: "ap",
      summary: "A file in the Google Drive folder was read into a draft for a person to add",
      detail: { inboxEmailId: ready?.id, driveFileId: id("Northwind"), fileName: "northwind-inv-2207.pdf", lastModifiedBy: "la***@pinecrest.example", read: "ready", document: { kind: "pdf", sha256 } },
    });
    expect(JSON.stringify(received)).not.toContain("lan@pinecrest.example");

    // The folder says when it was read, and the connection is due again at the next sweep.
    expect(folderRow(w)).toMatchObject({ last_read_at: new Date(w.clock.now).toISOString(), last_error: null });
    expect(connection(w)).toMatchObject({ last_synced_at: new Date(w.clock.now).toISOString(), next_sync_after: null, sync_lease_until: null, failures: 0 });

    // A second read finds nothing new and downloads nothing again: a file is read once.
    const before = downloads(w).length;
    expect(await sync(w)).toMatchObject({ outcome: "synced", counts: { found: 0 } });
    expect(downloads(w)).toHaveLength(before);
    expect(driveRows(w)).toHaveLength(5);
  });

  it("reads a file changed after it was read never again, and one moved in later as new, whatever its dates", async () => {
    const w = world();
    await choose(w);
    w.drop({ id: id("Read"), name: "inv.pdf" });
    await sync(w);
    w.drive.files.get(id("Read"))!.modifiedTime = new Date(w.clock.now + 60_000).toISOString();
    w.drop({ id: id("MovedIn"), name: "old-but-new.pdf", createdTime: "2025-01-01T00:00:00.000Z" });
    expect(await sync(w)).toMatchObject({ counts: { found: 1 } });
    expect(driveRows(w).map((row) => row.drive_file_id).sort()).toEqual([id("MovedIn"), id("Read")].sort());
  });

  it("tells the workspace's Slack channel, best effort (GD12)", async () => {
    const w = world({ slack: true });
    await choose(w);
    w.drop({ id: id("Northwind"), name: "northwind-inv-2207.pdf" });
    w.drop({ id: id("Photo"), name: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array(10), createdTime: new Date(START + 1000).toISOString() });
    await sync(w);
    expect(w.slack.map((post) => post.url)).toEqual([HOOK, HOOK]);
    const [readyPost, photoPost] = w.slack;
    expect(readyPost.body.text).toMatch(/^New invoice from Google Drive: \*northwind-inv-2207\.pdf\*: 200\.00 USDC, due \d{4}-\d{2}-\d{2}\. A person adds it in Bills &amp; receivables; nothing is paid until then\.$/);
    expect(JSON.stringify(readyPost.body.blocks)).toContain("https://www.vestiarion.xyz/o/pinecrest/invoices?review=email");
    expect(photoPost.body.text).toBe(`A file was added to the Google Drive folder, *receipt.jpg*, but it could not be read: ${DRIVE_REASONS.image("receipt.jpg")}`);

    // Slack down: the file is still read and waits in the review list.
    const down = world({ slack: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await choose(down);
    down.drop({ id: id("Northwind"), name: "northwind-inv-2207.pdf" });
    const result = await down.run(() =>
      syncGoogleDriveConnection(CONNECTION, down.provider, { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch })
    );
    expect(result).toMatchObject({ outcome: "synced", counts: { ready: 1 } });
  });

  it("reads five documents a minute: a file over that gets no row and is read next time (GD6)", async () => {
    const w = world();
    await choose(w);
    for (const name of ["A", "B", "C"]) w.drop({ id: id(`Limit${name}`), name: `inv-${name}.pdf`, createdTime: new Date(START + name.charCodeAt(0) * 1000).toISOString() });
    w.drop({ id: id("LimitPhoto"), name: "receipt.png", mimeType: "image/png", bytes: new Uint8Array(10), createdTime: new Date(START + 99_000).toISOString() });
    mocks.readTokens.left = 2;
    expect(await sync(w)).toMatchObject({ counts: { found: 3, ready: 2, unreadable: 1, left: 1 } });
    expect(driveRows(w).map((row) => row.drive_file_id).sort()).toEqual([id("LimitA"), id("LimitB"), id("LimitPhoto")].sort());
    mocks.readTokens.left = Infinity;
    expect(await sync(w)).toMatchObject({ counts: { found: 1, ready: 1, left: 0 } });
    expect(driveRows(w).map((row) => row.drive_file_id)).toContain(id("LimitC"));
  });

  it("starts no new file after 40 seconds: what is left is read next time (GD6)", async () => {
    const w = world();
    await choose(w);
    for (const name of ["A", "B", "C", "D"]) w.drop({ id: id(`Slow${name}`), name: `inv-${name}.pdf`, createdTime: new Date(START + name.charCodeAt(0) * 1000).toISOString() });
    // Each download takes Google 15 seconds.
    const slow = { ...w.provider, http: { ...w.provider.http, fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("alt=media")) w.clock.now += 15_000;
      return w.drive.fetch(input, init);
    }) as typeof fetch } };
    expect(await sync(w, slow)).toMatchObject({ outcome: "synced", counts: { found: 3, left: 1 } });
    expect(downloads(w)).toHaveLength(3);
    expect(await sync(w, slow)).toMatchObject({ counts: { found: 1, left: 0 } });
  });

  it("keeps a name cut in the middle of an emoji as Postgres takes it, and reads on past a row the database refuses (GD6, GD9)", async () => {
    // Anyone who can add a file chooses its name (GD9): a name cut to 255 UTF-16 units leaves half of the emoji, which
    // Postgres refuses, and the oldest file would then stop every file added after it from being read.
    const w = world();
    await choose(w);
    const grin = String.fromCodePoint(0x1f600);
    w.drop({ id: id("LongPdf"), name: `${"A".repeat(254)}${grin}.pdf` });
    w.drop({ id: id("LongPhoto"), name: `${"B".repeat(79)}${grin}.png`, mimeType: "image/png", bytes: new Uint8Array(10), createdTime: new Date(START + 1000).toISOString() });
    w.drop({ id: id("Refused"), name: "refused.pdf", createdTime: new Date(START + 2000).toISOString() });
    w.drop({ id: id("After"), name: "northwind-inv-2207.pdf", createdTime: new Date(START + 3000).toISOString() });
    // Whoever renames the folder chooses its name too.
    w.drive.files.get(FOLDER)!.name = `${"C".repeat(254)}${grin} bills`;
    // The database refuses one file's row, whatever the reason: that file is skipped and tried again next time.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    w.answer.current = (request) =>
      request.method === "POST" && request.path === "/rest/v1/inbox_emails" && JSON.stringify(request.body).includes(id("Refused"))
        ? { status: 503, body: { code: "57P01", message: "terminating connection due to administrator command", details: null, hint: null } }
        : undefined;

    expect(await sync(w)).toMatchObject({ outcome: "synced", folder: "read", counts: { found: 3, ready: 2, unreadable: 1, left: 1 } });
    const byFile = new Map(driveRows(w).map((row) => [row.drive_file_id, row]));
    expect(byFile.get(id("LongPdf"))).toMatchObject({ file_name: `${"A".repeat(254)}${grin}`, status: "ready" });
    expect(byFile.get(id("LongPhoto"))).toMatchObject({ file_name: `${"B".repeat(79)}${grin}.png`, status: "unreadable", reasons: [DRIVE_REASONS.image(`${"B".repeat(79)}${grin}.png`)] });
    expect(DRIVE_REASONS.image(`${"B".repeat(79)}${grin}.png`)).toContain(`(${"B".repeat(79)}${grin})`);
    expect(byFile.has(id("Refused"))).toBe(false);
    expect(byFile.get(id("After"))).toMatchObject({ status: "ready" });
    expect(String(errors.mock.calls.flat().join(" "))).toContain("57P01");
    // The entry keeps the first 120 characters, never half of one: it is signed, not dropped.
    const received = w.ledger().filter((entry) => entry.action === "invoice_drive_file_received");
    expect(received.find((entry) => entry.detail.driveFileId === id("LongPdf"))?.detail.fileName).toBe("A".repeat(120));
    expect(received).toHaveLength(3);
    expect(folderRow(w)).toMatchObject({ folder_name: `${"C".repeat(254)}${grin}`, last_read_at: new Date(w.clock.now).toISOString(), last_error: null });

    // Next time, the file whose row was refused is read.
    w.answer.current = null;
    expect(await sync(w)).toMatchObject({ outcome: "synced", counts: { found: 1, ready: 1, left: 0 } });
    expect(driveRows(w).map((row) => row.drive_file_id)).toContain(id("Refused"));
  });

  it("never reads a file twice when another read made its row first (GD6)", async () => {
    const w = world();
    await choose(w);
    w.drop({ id: id("Raced"), name: "inv.pdf" });
    // Another read inserts the file's row after this read looked at the review list, right before its own insert.
    const watching = beforeInsert(w, () => {
      w.db.rows("inbox_emails").push({
        id: crypto.randomUUID(), org_id: DRIVE_ORG, source: "google_drive", drive_file_id: id("Raced"), file_name: "inv.pdf", resend_email_id: null, from_address: null, subject: null,
        received_at: new Date(w.clock.now).toISOString(), status: "received", reasons: [], read: null, draft: null, authentication: null, invoice_id: null, decided_by: null, decided_at: null,
      });
    });
    expect(await sync(w)).toMatchObject({ outcome: "synced", counts: { found: 0 } });
    watching.stop();
    // The insert that ignores a duplicate made no second row, and the file was not downloaded by this read.
    const upsert = w.db.requests.find((request) => request.method === "POST" && request.path === "/rest/v1/inbox_emails");
    expect(upsert?.params.get("on_conflict")).toBe("org_id,drive_file_id");
    expect(upsert?.headers.get("prefer")).toContain("resolution=ignore-duplicates");
    expect(driveRows(w).filter((row) => row.drive_file_id === id("Raced"))).toHaveLength(1);
    expect(downloads(w)).toEqual([]);
  });
});

/** Runs `then` once, right before the read's insert into the review list is answered. */
function beforeInsert(w: DriveWorld, then: () => void) {
  const requests = w.db.requests;
  const push = requests.push.bind(requests);
  let armed = true;
  requests.push = (...items) => {
    for (const item of items) {
      if (armed && item.method === "POST" && item.path === "/rest/v1/inbox_emails") {
        armed = false;
        then();
      }
    }
    return push(...items);
  };
  return { stop: () => void (requests.push = push) };
}

describe("errors a person reads (GD13)", () => {
  it("says on the folder when it was deleted, trashed or no longer shared, and nothing else changes", async () => {
    const w = world();
    await choose(w);
    vi.spyOn(console, "error").mockImplementation(() => {});
    w.drive.hidden.add(FOLDER);
    expect(await sync(w)).toMatchObject({ outcome: "synced", folder: "gone", words: FOLDER_WORDS.folder_gone });
    expect(folderRow(w)).toMatchObject({ last_error: FOLDER_WORDS.folder_gone, last_error_kind: "folder_gone", last_read_at: null });
    expect(connection(w)).toMatchObject({ status: "connected", last_error: null, failures: 0, next_sync_after: null });

    w.drive.hidden.delete(FOLDER);
    w.drive.files.get(FOLDER)!.trashed = true;
    expect(await sync(w)).toMatchObject({ folder: "gone" });
    w.drive.files.get(FOLDER)!.trashed = false;
    // Restored: the next read clears the error.
    expect(await sync(w)).toMatchObject({ folder: "read" });
    expect(folderRow(w)).toMatchObject({ last_error: null, last_error_kind: null });
  });

  it("backs off as the core does on a rate limit, says so on the folder, and reads the file again next time", async () => {
    const w = world();
    await choose(w);
    vi.spyOn(console, "error").mockImplementation(() => {});
    w.drop({ id: id("Limited"), name: "inv.pdf" });
    // The folder and its listing answer; the download is refused for Google's rate limit, with no wait named.
    const limited = { ...w.provider, http: { ...w.provider.http, fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("alt=media") ? driveError(403, "userRateLimitExceeded", "User Rate Limit Exceeded") : w.drive.fetch(input, init)) as typeof fetch } };
    expect(await sync(w, limited)).toMatchObject({ outcome: "rate_limited", words: FOLDER_WORDS.rate_limited, counts: { found: 0, left: 1 } });
    // The row was taken back: the file waits for the next read, not with a misleading reason.
    expect(driveRows(w)).toEqual([]);
    expect(folderRow(w)).toMatchObject({ last_error: FOLDER_WORDS.rate_limited, last_error_kind: "rate_limited" });
    expect(connection(w)).toMatchObject({ failures: 1, next_sync_after: new Date(w.clock.now + 30_000).toISOString(), sync_lease_until: null });
    expect(String(connection(w).last_error)).toMatch(/^Google Drive asked Vestiarion to slow down\. Syncing again at /);

    // A listing refused with a 429 that names its wait waits that long.
    const w2 = world();
    await choose(w2);
    const listing429 = { ...w2.provider, http: { ...w2.provider.http, fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).pathname === "/drive/v3/files"
        ? new Response(JSON.stringify({ error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded", domain: "usageLimits", message: "Rate Limit Exceeded" }] } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } })
        : w2.drive.fetch(input, init)) as typeof fetch } };
    expect(await sync(w2, listing429)).toMatchObject({ outcome: "rate_limited" });
    expect(connection(w2)).toMatchObject({ failures: 1, next_sync_after: new Date(w2.clock.now + 120_000).toISOString() });
    mocks.tokens.current = w.tokens;

    // Next time, the file is read.
    w.clock.now += 60_000;
    expect(await sync(w)).toMatchObject({ outcome: "synced", counts: { found: 1, ready: 1 } });
    expect(connection(w)).toMatchObject({ failures: 0, last_error: null });
  });

  it("marks the connection to reconnect when the access was removed: invalid_grant, or a 401 after a refresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world();
    await choose(w);
    w.drop({ id: id("Waiting"), name: "inv.pdf" });
    w.drive.accessToken = "ya29.someone-else";
    w.drive.grantAlive = false;
    expect(await sync(w)).toMatchObject({ outcome: "reconnect" });
    expect(connection(w)).toMatchObject({ status: "needs_reconnect" });
    expect(String(connection(w).last_error)).toBe("Google no longer accepts this connection: its access was removed in the Google Account. Reconnect Google Drive to go on reading the new files in its folder.");
    expect(driveRows(w)).toEqual([]);
    // A connection to reconnect is not read.
    expect(await sync(w)).toMatchObject({ outcome: "busy" });
  });

  it("leaves a read that another holds: one read at a time", async () => {
    const w = world();
    await choose(w);
    connection(w).sync_lease_until = new Date(START + 60_000).toISOString();
    expect(await sync(w)).toEqual({ outcome: "busy", folder: "none" });
  });

  it("says a row left received by a read that stopped mid-way could not be read, so none waits without a reason", async () => {
    const w = world();
    await choose(w);
    w.db.rows("inbox_emails").push({
      id: crypto.randomUUID(), org_id: DRIVE_ORG, source: "google_drive", drive_file_id: id("Stuck"), file_name: "stuck.pdf", resend_email_id: null, from_address: null, subject: null,
      received_at: new Date(START - 20 * 60_000).toISOString(), status: "received", reasons: [], read: null, draft: null, authentication: null, invoice_id: null, decided_by: null, decided_at: null,
    });
    await sync(w);
    expect(driveRows(w).find((row) => row.drive_file_id === id("Stuck"))).toMatchObject({ status: "unreadable", reasons: [DRIVE_REASONS.unreadable] });
  });
});

describe("a folder chosen while it is read, or chosen again (GD4, GD5, GD13)", () => {
  const OTHER = id("OtherFolder");
  const addOther = (w: DriveWorld) =>
    w.drive.add({ id: OTHER, name: "Supplier invoices", mimeType: "application/vnd.google-apps.folder", parents: ["root"], createdTime: "2026-09-01T00:00:00.000Z" });

  it("claims nothing more from the folder it started with once another is chosen, or it is forgotten, and writes nothing on the new one", async () => {
    const w = world();
    await choose(w);
    addOther(w);
    w.drop({ id: id("First"), name: "inv-first.pdf" });
    w.drop({ id: id("Second"), name: "inv-second.pdf", createdTime: new Date(START + 1000).toISOString() });
    // An admin chooses another folder while the read claims its first file.
    w.answer.current = async (request) => {
      if (request.method !== "POST" || request.path !== "/rest/v1/inbox_emails") return;
      w.answer.current = null;
      w.clock.now += 5_000;
      expect(await choose(w, OTHER)).toMatchObject({ ok: true, again: false });
    };
    expect(await sync(w)).toMatchObject({ outcome: "synced", folder: "changed", counts: { found: 1, left: 1 } });
    // The old folder's second file is not claimed, and the new folder keeps its own name and state.
    expect(driveRows(w).map((row) => row.drive_file_id)).toEqual([id("First")]);
    expect(folderRow(w)).toMatchObject({ folder_id: OTHER, folder_name: "Supplier invoices", last_read_at: null, last_error: null, last_error_kind: null });
    // The connection is due again at the next sweep, which reads the new folder.
    expect(connection(w)).toMatchObject({ next_sync_after: null, failures: 0, sync_lease_until: null });

    // Disconnect forgets the folder: a read running then claims nothing more either.
    const forgotten = world();
    await choose(forgotten);
    forgotten.drop({ id: id("First"), name: "inv-first.pdf" });
    forgotten.drop({ id: id("Second"), name: "inv-second.pdf", createdTime: new Date(START + 1000).toISOString() });
    forgotten.answer.current = (request) => {
      if (request.method !== "POST" || request.path !== "/rest/v1/inbox_emails") return;
      forgotten.answer.current = null;
      forgotten.db.tables.google_drive_folders = [];
    };
    expect(await sync(forgotten)).toMatchObject({ folder: "changed", counts: { found: 1, left: 1 } });
    expect(driveRows(forgotten).map((row) => row.drive_file_id)).toEqual([id("First")]);
  });

  it("never puts the error of the folder it started with on the folder chosen since", async () => {
    const w = world();
    await choose(w);
    addOther(w);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // As the read begins, an admin chooses another folder, and the first is deleted.
    w.answer.current = async (request) => {
      if (request.method !== "PATCH" || request.path !== "/rest/v1/inbox_emails") return;
      w.answer.current = null;
      w.clock.now += 5_000;
      expect(await choose(w, OTHER)).toMatchObject({ ok: true });
      w.drive.hidden.add(FOLDER);
    };
    expect(await sync(w)).toMatchObject({ outcome: "synced", folder: "gone" });
    expect(folderRow(w)).toMatchObject({ folder_id: OTHER, folder_name: "Supplier invoices", last_error: null, last_error_kind: null, last_error_at: null });
  });

  it("reads the files added while the folder was gone once the same folder is chosen again: its baseline stays (GD5, GD13)", async () => {
    const w = world();
    w.drop({ id: id("Paid"), name: "paid.pdf", createdTime: "2026-10-01T00:00:00.000Z" });
    await choose(w);
    const first = { ...folderRow(w) };
    vi.spyOn(console, "error").mockImplementation(() => {});
    w.drive.hidden.add(FOLDER);
    expect(await sync(w)).toMatchObject({ folder: "gone", words: FOLDER_WORDS.folder_gone });
    expect(FOLDER_WORDS.folder_gone).toContain("Vestiarion reads it again by itself once that account can open it.");
    // The vendor's scanner goes on saving into the folder while the account cannot open it.
    w.clock.now += 60_000;
    w.drop({ id: id("WhileGone"), name: "northwind-inv-2207.pdf" });
    w.drive.hidden.delete(FOLDER);

    // The admin chooses the same folder again: its baseline, and who chose it when, stay; the error is cleared.
    w.clock.now += 60_000;
    expect(await choose(w)).toMatchObject({ ok: true, again: true, folder: { baseline: [id("Paid")] } });
    expect(rows(w, "google_drive_folders")).toHaveLength(1);
    expect(folderRow(w)).toMatchObject({ folder_id: FOLDER, baseline: [id("Paid")], chosen_at: first.chosen_at, chosen_by: OWNER, last_error: null, last_error_kind: null });
    expect(w.ledger().at(-1)).toMatchObject({
      action: "google_drive_folder_chosen",
      summary: "Chose the Google Drive folder Bills to pay again: the files added to it since it was first chosen come in for review. The 1 file in it when it was first chosen is still left as it is.",
      detail: { by: OWNER, folderId: FOLDER, baseline: 1 },
    });
    // The file saved meanwhile is read, not taken into a new baseline.
    expect(await sync(w)).toMatchObject({ outcome: "synced", folder: "read", counts: { found: 1, ready: 1 } });
    expect(driveRows(w).map((row) => row.drive_file_id)).toEqual([id("WhileGone")]);
  });

  it("names no files left as they are when an empty folder is chosen (GD11)", async () => {
    const w = world();
    await choose(w);
    expect(w.ledger().at(-1)).toMatchObject({
      action: "google_drive_folder_chosen",
      summary: "Chose the Google Drive folder Bills to pay: the files added to it from now on come in for review.",
      detail: { baseline: 0 },
    });
  });
});

describe("the 15-minute sweeper (GD7)", () => {
  it("reads a due Google Drive connection's folder through its intake slot, leaving Asana's and Linear's slots alone", async () => {
    const w = world();
    await choose(w);
    w.drop({ id: id("Swept"), name: "northwind-inv-2207.pdf" });
    const work = vi.fn();
    const summary = await w.run(() =>
      sweepAccounting({
        providerFor: () => null,
        work: { providerFor: () => null, sync: work },
        intake: { providerFor: (provider) => (provider === "googledrive" ? w.provider : null), sync: (connectionId, provider) => syncGoogleDriveConnection(connectionId, provider as GoogleDriveProvider) },
      })
    );
    expect(summary).toMatchObject({ setUp: true, connections: 1, synced: 1, failed: 0 });
    expect(work).not.toHaveBeenCalled();
    expect(driveRows(w)).toHaveLength(1);
    // Due again 15 minutes on, unlike Sheets', which is parked for good.
    expect(connection(w).next_sync_after).toBeNull();
  });

  it("is wired into the sweeper's route: a due googledrive connection is read there, answering counts only", async () => {
    const w = world();
    await choose(w);
    w.drop({ id: id("Routed"), name: "northwind-inv-2207.pdf" });
    mocks.provider.current = w.provider;
    vi.stubEnv("AGENT_API_TOKEN", "agent-token-for-tests-0123456789");
    try {
      const response = await w.run(() =>
        sweepRoute(new Request("https://www.vestiarion.xyz/api/platform/accounting-sync", { method: "POST", headers: { authorization: "Bearer agent-token-for-tests-0123456789" } }))
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ setUp: true, connections: 1, synced: 1, failed: 0 });
      expect(driveRows(w).map((row) => row.drive_file_id)).toEqual([id("Routed")]);
    } finally {
      vi.unstubAllEnvs();
      mocks.provider.current = null;
    }
  });

  it("leaves a deployment without Google Drive's provider alone", async () => {
    const w = world();
    await choose(w);
    const summary = await w.run(() => sweepAccounting({ providerFor: () => null, intake: { providerFor: () => null, sync: vi.fn() } }));
    expect(summary).toMatchObject({ connections: 0 });
  });
});
