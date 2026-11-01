import type { Connection } from "@/lib/connectors/connections";
import type { InboxEmailView } from "@/lib/email-inbox/list";
import type { DriveFolderRow } from "@/lib/googledrive/store";
import type { GoogleDriveFigures } from "@/lib/googledrive/views";

/**
 * Sample data for /docs-shots/googledrive (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md, Screens), as
 * Linear's fixture: a workspace connected to its owner's Google account, the folder "Bills 2026" chosen with two files
 * already in it, and, in the review list on Bills & receivables, a PDF found in that folder ready to add beside an
 * emailed invoice. Every view is built from these by the pages' own functions. Sample names, ids and masked emails only.
 */

export const GOOGLE_DRIVE_NOW = Date.parse("2026-11-01T10:30:00.000Z");

export const GOOGLE_DRIVE_CONNECTION: Connection = {
  id: "docs-googledrive-connection",
  orgId: "docs-sample-org",
  provider: "googledrive",
  externalOrgId: "04815162342108153564",
  externalOrgName: "ow***@pinecrest.test",
  status: "connected",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  connectedBy: "docs-sample-owner",
  connectedAt: "2026-11-01T08:00:00.000Z",
  consentVersion: "googledrive-2026-11-01",
  consentedAt: "2026-11-01T08:00:00.000Z",
  revokedAt: null,
  windowFrom: "2026-11-01",
  lastSyncedAt: "2026-11-01T10:24:00.000Z",
  lastError: null,
  lastErrorAt: null,
  failures: 0,
  nextSyncAfter: null,
  syncLeaseUntil: null,
  paymentAccount: null,
  paymentAccountAt: null,
};

export const GOOGLE_DRIVE_FOLDER: DriveFolderRow = {
  id: "docs-googledrive-folder",
  orgId: "docs-sample-org",
  connectionId: GOOGLE_DRIVE_CONNECTION.id,
  folderId: "1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456",
  folderName: "Bills 2026",
  sharedDriveId: null,
  baseline: ["1oldPaidBillOctoberAaaaaaaaaaaaaaa", "1oldPaidBillSeptemberBbbbbbbbbbbbb"],
  chosenBy: "docs-sample-owner",
  chosenAt: "2026-11-01T08:05:00.000Z",
  lastReadAt: "2026-11-01T10:24:00.000Z",
  lastError: null,
  lastErrorKind: null,
  lastErrorAt: null,
};

export const GOOGLE_DRIVE_FIGURES: GoogleDriveFigures = { read30d: 3, waiting: 1, added30d: 2 };

/** The review list: a PDF found in the folder, ready to add, beside an emailed invoice. */
export const REVIEW_ROWS: InboxEmailView[] = [
  {
    id: "00000000-0000-4000-8000-0000000000f1",
    source: "google_drive",
    from: null,
    subject: null,
    fileName: "Coastal Flour Mill - INV-3318.pdf",
    lastModifiedBy: "bo***@pinecrest.test",
    receivedAt: "2026-11-01T10:24:00Z",
    status: "ready",
    reasons: [],
    authentication: null,
    read: {
      counterpartyName: "Coastal Flour Mill",
      vendorName: "Coastal Flour Mill",
      amount: "640.00",
      currency: "USDC",
      dueDate: "2026-11-20",
      poReference: "PO-2291",
      invoiceNumber: "INV-3318",
      memo: null,
      warnings: [],
      modelNote: null,
      reader: "deepseek",
      knownSender: false,
    },
  },
  {
    id: "00000000-0000-4000-8000-0000000000e1",
    source: "email",
    fileName: null,
    lastModifiedBy: null,
    from: "Northwind Billing <billing@northwind.example>",
    subject: "Invoice INV-2207",
    receivedAt: "2026-10-31T16:00:00Z",
    status: "ready",
    reasons: [],
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    read: {
      counterpartyName: "Northwind Hosting",
      vendorName: "Northwind Hosting",
      amount: "200.00",
      currency: "USDC",
      dueDate: "2026-11-30",
      poReference: "PO-1042",
      invoiceNumber: "INV-2207",
      memo: null,
      warnings: [],
      modelNote: null,
      reader: "deepseek",
      knownSender: true,
    },
  },
];

export const REVIEW_COUNTERPARTIES = [
  { id: "00000000-0000-4000-8000-0000000000d2", name: "Coastal Flour Mill", role: "vendor" },
  { id: "00000000-0000-4000-8000-0000000000d3", name: "Northwind Hosting", role: "vendor" },
];
