import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { can, type OrgRole } from "@/lib/auth/roles";
import type { Permission } from "@/lib/auth/roles";
import type { TokenStore } from "@/lib/connectors/tokens";
import { signedOrgs } from "./support/signed-org";

/**
 * What a person sees and decides of a file from Google Drive (docs/superpowers/specs/2026-11-01-google-drive-intake-
 * design.md GD2, GD4, GD7, GD8, GD10, GD11, GD15), over the real stores and actions: the review list holds Drive rows
 * beside emails, newest first, naming the file and who last changed it, masked; Add, Finish and Dismiss work for a Drive
 * row with the same roles and the same one-use guarded update, its entries naming Google Drive and the file; the words
 * both reach say invoice. The actions: Choose (an owner's or admin's), Check Google Drive now (whoever adds invoices),
 * Disconnect, which revokes at Google only when the account is connected nowhere else and forgets the folder. And the
 * card's view.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    tokens: { current: null as TokenStore | null },
    role: { current: "owner" as string },
    revalidate: vi.fn(),
    provider: { current: null as unknown },
    refreshToken: vi.fn(async () => "1//0g-refresh"),
    deleteTokens: vi.fn(async () => undefined),
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: vi.fn() }));
vi.mock("@/lib/usage/record", () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: mocks.revalidate }));
// Five reads a minute per workspace is tested in tests/googledrive-flow.test.ts; here every test reads in one workspace.
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), takeDocumentReadToken: () => true }));
vi.mock("@/lib/connectors/token-store", async (original) => ({
  ...(await original<typeof import("@/lib/connectors/token-store")>()),
  connectionTokenStore: () => mocks.tokens.current,
  refreshTokenOf: mocks.refreshToken,
  deleteTokens: mocks.deleteTokens,
}));
// The deployment's Google Drive, on the fake Drive of each test.
vi.mock("@/lib/googledrive/provider", async (original) => {
  const actual = await original<typeof import("@/lib/googledrive/provider")>();
  return {
    ...actual,
    googleDriveProviderFromEnv: () => mocks.provider.current,
    // The deployment's own, built from its settings alone, is the test's; one built with its own calls is the real one.
    googleDriveProvider: (...args: Parameters<typeof actual.googleDriveProvider>) => (args.length === 1 && mocks.provider.current ? mocks.provider.current : actual.googleDriveProvider(...args)),
  };
});
vi.mock("@/lib/auth/authorize", () => ({
  authorize: async (_slug: unknown, permission: Permission) => {
    const role = mocks.role.current as OrgRole;
    if (!can(role, permission)) return { ok: false, message: `Your role in this workspace (${role}) cannot do that.` };
    return { ok: true, user: { id: OWNER, email: "lan@pinecrest.example" }, membership: { orgId: DRIVE_ORG, slug: "pinecrest", name: "Pinecrest Studio", role, mode: "live", network: "arc-testnet" } };
  },
}));

import { checkGoogleDriveNowAction, chooseGoogleDriveFolderAction, disconnectGoogleDriveAction } from "@/app/actions/googledrive";
import type { Actor } from "@/lib/commands/actor";
import { addFromInbox, dismissFromInbox, finishFromInbox } from "@/lib/commands/inbox";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { inboxEmailsToDecide } from "@/lib/email-inbox/list";
import { googleDriveCheckFor, googleDrivePanelFor } from "@/lib/googledrive/panel";
import { FOLDER_WORDS } from "@/lib/googledrive/read";
import { invoiceInputSchema } from "@/lib/intake-validation";
import { connectionRow, CONNECTION, DRIVE_ORG, DRIVE_SETTINGS, driveWorld, FOLDER, OTHER_ORG, OWNER, START, type DriveWorld } from "./support/drive-world";

const orgs = signedOrgs();
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const id = (name: string) => `1${name}${"x".repeat(Math.max(0, 32 - name.length))}`.slice(0, 33);
const EMPTY = { ok: false, message: "" };

beforeEach(() => {
  mocks.role.current = "owner";
  mocks.revalidate.mockReset();
  mocks.refreshToken.mockClear();
  mocks.deleteTokens.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("GOOGLE_DRIVE_CLIENT_ID", DRIVE_SETTINGS.clientId);
  vi.stubEnv("GOOGLE_DRIVE_CLIENT_SECRET", DRIVE_SETTINGS.clientSecret);
  vi.stubEnv("GOOGLE_SHEETS_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_SHEETS_CLIENT_SECRET", "");
});

function world(seed: Record<string, Array<Record<string, unknown>>> = {}): DriveWorld & { revoke: ReturnType<typeof vi.fn> } {
  const made = driveWorld({ orgRow: orgs.orgRow, seed });
  const revoke = vi.fn(async () => true);
  mocks.tokens.current = made.tokens;
  mocks.provider.current = { ...made.provider, revoke };
  return { ...made, revoke };
}

/** An action, run as the server runs it: outside any workspace, which the action enters itself. */
const act = <T,>(w: DriveWorld, fn: () => Promise<T>) => runWith({ config, db: w.db.client, fetch: w.db.fetch }, fn);
function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("orgSlug", "pinecrest");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const actor = (role: Actor["role"] = "admin"): Actor => ({ orgId: DRIVE_ORG, userId: OWNER, role, mode: "live", surface: { kind: "console" } });
const row = (w: DriveWorld, rowId: string) => w.db.rows("inbox_emails").find((one) => one.id === rowId) ?? {};

/** A workspace whose folder was chosen and read: one Drive file ready, one unreadable, beside an email. */
async function withReadFolder(): Promise<DriveWorld & { revoke: ReturnType<typeof vi.fn>; ready: string; unreadable: string; email: string }> {
  const w = world();
  const email = crypto.randomUUID();
  w.db.rows("inbox_emails").push({
    id: email, org_id: DRIVE_ORG, source: "email", resend_email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", drive_file_id: null, file_name: null, from_address: "Northwind Billing <billing@northwind.example>",
    subject: "Invoice INV-2208", received_at: new Date(START - 3_600_000).toISOString(), status: "ready", reasons: [], read: null, draft: null,
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, invoice_id: null, decided_by: null, decided_at: null,
  });
  expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: `https://drive.google.com/drive/folders/${FOLDER}` })))).toMatchObject({ ok: true });
  w.clock.now += 60_000;
  w.drop({ id: id("Ready"), name: "northwind-inv-2207.pdf", lastModifyingUser: { displayName: "Lan Tran", emailAddress: "lan@pinecrest.example" } });
  w.drop({ id: id("Photo"), name: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array(10), createdTime: new Date(w.clock.now + 1000).toISOString() });
  expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toMatchObject({ ok: true });
  const byFile = (fileId: string) => String(w.db.rows("inbox_emails").find((one) => one.drive_file_id === fileId)?.id);
  return { ...w, ready: byFile(id("Ready")), unreadable: byFile(id("Photo")), email };
}

describe("the review list (Google Drive intake GD8)", () => {
  it("holds Drive rows beside emails, newest first: the file, when it was found, who last changed it masked, and no sender", async () => {
    const w = await withReadFolder();
    const list = await w.run(() => inboxEmailsToDecide());
    expect(list.map((one) => one.source)).toEqual(["google_drive", "google_drive", "email"]);
    const ready = list.find((one) => one.id === w.ready);
    expect(ready).toMatchObject({
      source: "google_drive",
      fileName: "northwind-inv-2207.pdf",
      lastModifiedBy: "la***@pinecrest.example",
      from: null,
      subject: null,
      authentication: null,
      status: "ready",
      read: { counterpartyName: "Northwind Hosting", amount: "200.00", knownSender: false },
    });
    expect(list.find((one) => one.id === w.unreadable)).toMatchObject({ source: "google_drive", fileName: "receipt.jpg", lastModifiedBy: null, status: "unreadable" });
    expect(list.find((one) => one.id === w.email)).toMatchObject({
      source: "email",
      fileName: null,
      lastModifiedBy: null,
      from: "Northwind Billing <billing@northwind.example>",
      subject: "Invoice INV-2208",
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    });
  });
});

describe("deciding a Drive row (GD8, GD10, GD11)", () => {
  it("adds it once, as the member, the entry naming Google Drive, the row and the file, and links the invoice", async () => {
    const w = await withReadFolder();
    const added = await w.run(() => addFromInbox(actor(), { inboxEmailId: w.ready, goodsReceived: true }));
    expect(added).toMatchObject({ ok: true });
    expect(row(w, w.ready)).toMatchObject({ status: "added", decided_by: OWNER, invoice_id: (added as { invoiceId: string }).invoiceId });
    const entry = w.ledger().find((one) => one.action === "create_invoice");
    expect(entry?.detail).toMatchObject({ by: OWNER, via: "google_drive", inboxEmailId: w.ready, driveFileId: id("Ready"), document: { kind: "pdf", changed: [] } });
    expect(await w.run(() => addFromInbox(actor(), { inboxEmailId: w.ready, goodsReceived: true }))).toMatchObject({
      ok: false,
      code: "not_ready",
      message: "This invoice was already decided, or cannot be added as it was read.",
    });
  });

  it("finishes an unreadable one by hand, the entry naming Google Drive", async () => {
    const w = await withReadFolder();
    const invoice = invoiceInputSchema.parse({
      direction: "payable", counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", amount: "45.00", currency: "USDC", memo: "Receipt", poReference: "", invoiceNumber: "",
      goodsReceived: true, dueDate: "2026-11-30", earlyPayDiscountPct: "", discountDeadline: "",
    });
    const finished = await w.run(() => finishFromInbox(actor(), { inboxEmailId: w.unreadable, invoice }));
    expect(finished).toMatchObject({ ok: true });
    expect(w.ledger().find((one) => one.action === "create_invoice")?.detail).toMatchObject({ via: "google_drive", inboxEmailId: w.unreadable, driveFileId: id("Photo") });
    expect(await w.run(() => finishFromInbox(actor(), { inboxEmailId: w.unreadable, invoice }))).toMatchObject({ ok: false, message: "This invoice was already decided." });
    expect(await w.run(() => finishFromInbox(actor(), { inboxEmailId: w.ready, invoice: { ...invoice, direction: "receivable" } }))).toMatchObject({
      ok: false,
      message: "An invoice in the review list is a payable.",
    });
  });

  it("dismisses a Drive row as invoice_drive_file_dismissed, and an email as invoice_email_dismissed, as before", async () => {
    const w = await withReadFolder();
    expect(await w.run(() => dismissFromInbox(actor(), { inboxEmailId: w.unreadable }))).toMatchObject({ ok: true });
    expect(await w.run(() => dismissFromInbox(actor(), { inboxEmailId: w.email }))).toMatchObject({ ok: true });
    const dismissed = w.ledger().filter((one) => one.action.endsWith("_dismissed"));
    expect(dismissed).toEqual([
      expect.objectContaining({ action: "invoice_drive_file_dismissed", actor: "human", domain: "ap", detail: { by: OWNER, inboxEmailId: w.unreadable, driveFileId: id("Photo") } }),
      expect.objectContaining({ action: "invoice_email_dismissed", detail: { by: OWNER, inboxEmailId: w.email } }),
    ]);
    expect(await w.run(() => dismissFromInbox(actor(), { inboxEmailId: w.unreadable }))).toMatchObject({ ok: false, message: "This invoice was already decided." });
  });

  it("refuses an approver or a viewer before touching the row, as for an email", async () => {
    const w = await withReadFolder();
    for (const role of ["approver", "viewer"] as const) {
      expect(await w.run(() => addFromInbox(actor(role), { inboxEmailId: w.ready, goodsReceived: true }))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await w.run(() => dismissFromInbox(actor(role), { inboxEmailId: w.ready }))).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(row(w, w.ready)).toMatchObject({ status: "ready", decided_by: null });
  });
});

describe("before migration 0148 runs (GD3)", () => {
  it("goes on listing and deciding emails as before, reading none of 0148's columns", async () => {
    const w = driveWorld({ orgRow: orgs.orgRow, before0148: true });
    const email = crypto.randomUUID();
    const STORED = {
      draft: { counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", amount: "200.00", currency: "USDC", memo: "", poReference: "PO-1042", dueDate: "2026-11-30", earlyPayDiscountPct: "", discountDeadline: "" },
      document: { kind: "pdf", sha256: "a".repeat(64), reader: "heuristic" },
    };
    const emailRow = (rowId: string) => ({
      id: rowId, org_id: DRIVE_ORG, resend_email_id: crypto.randomUUID(), from_address: "billing@northwind.example", subject: "Invoice INV-2209", received_at: new Date(START).toISOString(),
      status: "ready", reasons: [], read: null, draft: STORED, authentication: null, invoice_id: null, decided_by: null, decided_at: null,
    });
    const other = crypto.randomUUID();
    w.db.rows("inbox_emails").push(emailRow(email), emailRow(other));
    const list = await w.run(() => inboxEmailsToDecide());
    expect(list.map((one) => [one.id, one.source, one.fileName])).toEqual([
      [email, "email", null],
      [other, "email", null],
    ]);
    expect(await w.run(() => addFromInbox(actor(), { inboxEmailId: email, goodsReceived: true }))).toMatchObject({ ok: true });
    expect(w.ledger().find((one) => one.action === "create_invoice")?.detail).toMatchObject({ via: "email", inboxEmailId: email });
    expect(w.ledger().find((one) => one.action === "create_invoice")?.detail).not.toHaveProperty("driveFileId");
    expect(await w.run(() => dismissFromInbox(actor(), { inboxEmailId: other }))).toMatchObject({ ok: true });
    expect(w.ledger().find((one) => one.action.endsWith("_dismissed"))).toMatchObject({ action: "invoice_email_dismissed" });
    // The first ask named 0148's columns and was refused whole; nothing was written by it.
    expect(w.db.requests.some((request) => request.params.get("select")?.includes("source"))).toBe(true);
    expect(w.db.rows("inbox_emails").map((one) => one.status).sort()).toEqual(["added", "dismissed"]);
  });
});

describe("chooseGoogleDriveFolderAction (GD4, GD5)", () => {
  it("is an owner's or admin's: an approver, a viewer or an accountant is refused with the role message", async () => {
    const w = world();
    for (const role of ["approver", "viewer", "accountant"]) {
      mocks.role.current = role;
      expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })))).toEqual({ ok: false, message: `Your role in this workspace (${role}) cannot do that.` });
    }
    expect(w.drive.requests).toEqual([]);
  });

  it("answers the folder read, its link and its baseline, or what to do", async () => {
    const w = world();
    w.drop({ id: id("Old"), name: "paid.pdf", createdTime: "2026-10-01T00:00:00.000Z" });
    expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing` })))).toEqual({
      ok: true,
      message: "Vestiarion now reads Bills to pay. Files added to it from now on come in for review on Bills & receivables; the 1 file already in it is left as it is.",
      folder: { name: "Bills to pay", url: `https://drive.google.com/drive/folders/${FOLDER}`, baseline: 1 },
    });
    expect(mocks.revalidate).toHaveBeenCalled();
    expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view" })))).toEqual({
      ok: false,
      message: "Paste the folder's link from Google Drive (drive.google.com/drive/folders/...), or its ID.",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: id("Missing") })))).toEqual({
      ok: false,
      message: "Google Drive has no folder at that link that la***@pinecrest.example can open. Check the link, and that the folder is shared with that account.",
    });
    // The same folder chosen again keeps the files it left then (GD5).
    expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })))).toEqual({
      ok: true,
      message: "Vestiarion reads Bills to pay again. Files added to it since it was first chosen come in for review on Bills & receivables; the 1 file in it then is still left as it is.",
      folder: { name: "Bills to pay", url: `https://drive.google.com/drive/folders/${FOLDER}`, baseline: 1 },
    });
  });

  it("names no files left as they are when the folder chosen is empty, as the card recommends", async () => {
    const w = world();
    expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })))).toEqual({
      ok: true,
      message: "Vestiarion now reads Bills to pay. Files added to it from now on come in for review on Bills & receivables.",
      folder: { name: "Bills to pay", url: `https://drive.google.com/drive/folders/${FOLDER}`, baseline: 0 },
    });
    expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })))).toMatchObject({
      message: "Vestiarion reads Bills to pay again. Files added to it since it was first chosen come in for review on Bills & receivables.",
    });
  });

  it("says the folder holds too many files, which the 1,000 it takes are not", async () => {
    const w = world();
    for (let index = 0; index < 1001; index += 1) w.drop({ id: `1Many${String(index).padStart(28, "0")}`, name: `old-${index}.pdf` });
    expect(await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })))).toEqual({ ok: false, message: "That folder holds more than 1,000 files. Choose a new, empty folder, or one with at most 1,000 files." });
  });
});

describe("checkGoogleDriveNowAction (GD7)", () => {
  it("is for whoever adds invoices: an approver or a viewer is refused", async () => {
    const w = world();
    for (const role of ["approver", "viewer"]) {
      mocks.role.current = role;
      expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toMatchObject({ ok: false, message: `Your role in this workspace (${role}) cannot do that.` });
    }
  });

  it("reads the folder now and answers what it found, with the counts", async () => {
    const w = world();
    await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })));
    expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({
      ok: true,
      message: "Checked Bills to pay. No new file.",
      counts: { listed: 0, found: 0, ready: 0, needsDetails: 0, unreadable: 0, left: 0 },
    });
    w.drop({ id: id("New"), name: "northwind-inv-2207.pdf" });
    expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({
      ok: true,
      message: "Found 1 file in Bills to pay. It waits in the review list on Bills & receivables.",
      counts: { listed: 1, found: 1, ready: 1, needsDetails: 0, unreadable: 0, left: 0 },
    });
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("says what to do with no folder, a folder gone, a grant to reconnect, or Google Drive not connected", async () => {
    const w = world();
    expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({ ok: false, message: "No folder is chosen yet. An owner or admin chooses it on the Google Drive card in Settings." });
    await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    w.drive.hidden.add(FOLDER);
    expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({ ok: false, message: FOLDER_WORDS.folder_gone });
    w.drive.hidden.delete(FOLDER);
    w.tokens.row = { ...w.tokens.row, expiresAt: START - 1 };
    w.drive.grantAlive = false;
    expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({ ok: false, message: "Google Drive needs you to reconnect. An owner or admin can reconnect it in Settings." });
    expect(await act(w, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({ ok: false, message: "Google Drive needs you to reconnect. An owner or admin can reconnect it in Settings." });
    const none = world({ accounting_connections: [] });
    expect(await act(none, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({ ok: false, message: "Google Drive is not connected to this workspace." });
  });
});

describe("disconnectGoogleDriveAction (GD2)", () => {
  it("revokes at Google, deletes the tokens, marks the connection revoked, forgets the folder, and keeps the files read", async () => {
    const w = await withReadFolder();
    expect(await act(w, () => disconnectGoogleDriveAction(EMPTY, form()))).toEqual({ ok: true, message: "Google Drive is disconnected. Files already read stay in the review list on Bills & receivables." });
    expect(w.revoke).toHaveBeenCalledWith("1//0g-refresh");
    expect(mocks.deleteTokens).toHaveBeenCalled();
    expect(w.db.rows("accounting_connections").find((one) => one.id === CONNECTION)).toMatchObject({ status: "revoked", revoked_by: OWNER });
    expect(w.db.rows("google_drive_folders")).toEqual([]);
    expect(w.db.rows("inbox_emails").filter((one) => one.source === "google_drive")).toHaveLength(2);
    expect(w.ledger().find((one) => one.action === "accounting_disconnected")?.detail).toMatchObject({ provider: "googledrive", connectionId: CONNECTION, revokedAtProvider: true });
  });

  it("does not revoke while the same Google account is connected to another workspace", async () => {
    const w = world({
      accounting_connections: [connectionRow(), connectionRow({ id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7f22", org_id: OTHER_ORG })],
    });
    const answer = await act(w, () => disconnectGoogleDriveAction(EMPTY, form()));
    expect(answer.message).toContain("The same Google account is still connected elsewhere in Vestiarion");
    expect(w.revoke).not.toHaveBeenCalled();
    expect(w.db.rows("accounting_connections").find((one) => one.id === CONNECTION)).toMatchObject({ status: "revoked" });
  });

  it("does not revoke while Google Sheets holds the same account on the same OAuth client, and does on another client", async () => {
    const sheets = connectionRow({ id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000d7f23", provider: "googlesheets", consent_version: "googlesheets-2026-10-25" });
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_ID", DRIVE_SETTINGS.clientId);
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_SECRET", DRIVE_SETTINGS.clientSecret);
    const shared = world({ accounting_connections: [connectionRow(), sheets] });
    await act(shared, () => disconnectGoogleDriveAction(EMPTY, form()));
    expect(shared.revoke).not.toHaveBeenCalled();

    vi.stubEnv("GOOGLE_SHEETS_CLIENT_ID", "9876543210-zyx987.apps.googleusercontent.com");
    const apart = world({ accounting_connections: [connectionRow(), sheets] });
    await act(apart, () => disconnectGoogleDriveAction(EMPTY, form()));
    expect(apart.revoke).toHaveBeenCalled();
  });

  it("is an owner's or admin's", async () => {
    const w = world();
    mocks.role.current = "accountant";
    expect(await act(w, () => disconnectGoogleDriveAction(EMPTY, form()))).toEqual({ ok: false, message: "Your role in this workspace (accountant) cannot do that." });
    expect(w.db.rows("accounting_connections")[0]).toMatchObject({ status: "connected" });
  });
});

describe("the card and the review list's offer (GD3, GD15, GD16)", () => {
  it("shows the account, the folder, its last read and the figures over 30 days", async () => {
    const w = await withReadFolder();
    await w.run(() => addFromInbox(actor(), { inboxEmailId: w.ready, goodsReceived: true }));
    const panel = await w.run(() => googleDrivePanelFor(w.clock.now + 3 * 60_000));
    expect(panel).toEqual({
      state: "connected",
      account: "la***@pinecrest.example",
      connectedAt: "Nov 1",
      folder: {
        id: FOLDER,
        name: "Bills to pay",
        url: `https://drive.google.com/drive/folders/${FOLDER}`,
        chosenOn: "Nov 1",
        baseline: 0,
        lastRead: "Last read 3 minutes ago.",
        problem: null,
        askAgain: false,
      },
      figures: { read30d: 2, waiting: 1, added30d: 1 },
    });
    expect(await w.run(() => googleDriveCheckFor())).toEqual({ folderName: "Bills to pay", problem: null });
  });

  it("counts the bills added in the last 30 days by when a person added them, whenever their file was found (GD15)", async () => {
    const w = world();
    await act(w, () => chooseGoogleDriveFolderAction(EMPTY, form({ folder: FOLDER })));
    const DAY = 86_400_000;
    const driveRow = (name: string, foundDaysAgo: number, addedDaysAgo: number | null) => ({
      id: crypto.randomUUID(), org_id: DRIVE_ORG, source: "google_drive", resend_email_id: null, drive_file_id: id(name), file_name: `${name}.pdf`, from_address: null, subject: null,
      received_at: new Date(w.clock.now - foundDaysAgo * DAY).toISOString(), status: addedDaysAgo === null ? "ready" : "added", reasons: [], read: null, draft: null, authentication: null,
      invoice_id: null, decided_by: addedDaysAgo === null ? null : OWNER, decided_at: addedDaysAgo === null ? null : new Date(w.clock.now - addedDaysAgo * DAY).toISOString(),
    });
    // Found 35 days ago and added yesterday: added in the last 30 days. Found 40 days ago and added 35 days ago: not.
    w.db.rows("inbox_emails").push(driveRow("FoundLongAgo", 35, 1), driveRow("AddedLongAgo", 40, 35), driveRow("Waiting", 2, null));
    expect(await w.run(() => googleDrivePanelFor(w.clock.now))).toMatchObject({ state: "connected", figures: { read30d: 1, waiting: 1, added30d: 1 } });
  });

  it("asks for a folder again when it is gone, says not set up before 0148, and is not there without the client", async () => {
    const w = await withReadFolder();
    vi.spyOn(console, "error").mockImplementation(() => {});
    w.drive.hidden.add(FOLDER);
    await act(w, () => checkGoogleDriveNowAction(EMPTY, form()));
    const panel = await w.run(() => googleDrivePanelFor(w.clock.now));
    expect(panel).toMatchObject({ state: "connected", folder: { problem: FOLDER_WORDS.folder_gone, askAgain: true } });
    // The review list says the same, never that it reads the folder every 15 minutes (GD13).
    expect(await w.run(() => googleDriveCheckFor())).toEqual({ folderName: "Bills to pay", problem: FOLDER_WORDS.folder_gone });

    const before = driveWorld({ orgRow: orgs.orgRow, ready: false });
    expect(await before.run(() => googleDrivePanelFor())).toEqual({ state: "not_set_up" });
    expect(await before.run(() => googleDriveCheckFor())).toBeNull();
    mocks.provider.current = before.provider;
    expect(await runWith({ config, db: before.db.client, fetch: before.db.fetch }, () => checkGoogleDriveNowAction(EMPTY, form()))).toEqual({
      ok: false,
      message: "Google Drive is not set up on this deployment yet.",
    });
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_ID", "");
    expect(await w.run(() => googleDrivePanelFor())).toBeNull();
    expect(await w.run(() => googleDriveCheckFor())).toBeNull();
  });
});
