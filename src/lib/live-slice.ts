import { z } from "zod";
import { createCounterparty } from "./counterparties/create";
import { currentOrgId } from "./context";
import { db, platformDb, unwrap, type OrgDb } from "./dal";
import { withOrg } from "./dal/scope";
import { counterpartyInputSchema } from "./intake-validation";
import { appendLedgerEntry, assertLedgerCanSign } from "./ledger";
import { createWorkspace, WorkspaceLimitError } from "./platform/workspace";
import { readShadowMode } from "./shadow-mode";
import { workspaceNetwork } from "./workspace-network";

/**
 * Start the live slice (docs/superpowers/specs/2026-10-18-live-slice-design.md L1-L6): from a workspace in shadow mode on
 * Arc testnet, an owner opens a workspace on Arc mainnet, owned by them and made by the usual `createWorkspace`, with the
 * vendors they chose carried over. A vendor's own address is carried and waits for a person to confirm it there; a mirror
 * address, a wallet of the shadow workspace's on Arc testnet, never is. No bill, history or verdict is carried, and the new
 * workspace is not live: going live is the business's next step. The shadow workspace signs `live_slice_started`.
 */

export const LIVE_SLICE_STARTED = "live_slice_started";
/** The most vendors one slice carries. */
export const SLICE_MAX_VENDORS = 25;

export type SliceAddress = "own" | "mirror" | "none";

export interface SliceVendor {
  id: string;
  name: string;
  address: SliceAddress;
  /** The payment limit the business set; a vendor without one is not carried (L3). */
  paymentLimit: number | null;
}

export interface LiveSlice {
  orgId: string;
  slug: string;
  name: string;
  live: boolean;
  startedAt: string;
  vendors: number;
}

export type SliceErrorCode = "not_shadow" | "mainnet_workspace" | "no_vendors" | "too_many" | "already" | "limit";

export const SLICE_MESSAGES: Record<SliceErrorCode, string> = {
  not_shadow: "A live slice starts from a workspace in shadow mode.",
  mainnet_workspace: "This workspace is on Arc mainnet already.",
  no_vendors: "Choose at least one vendor with a payment limit to pay for real.",
  too_many: `Choose at most ${SLICE_MAX_VENDORS} vendors for a first slice.`,
  already: "A live slice was opened from this workspace already. Open it from the report.",
  limit: "You already have 3 workspaces on Arc mainnet, the most one person can create there.",
};

export class SliceError extends Error {
  constructor(readonly code: SliceErrorCode) {
    super(SLICE_MESSAGES[code]);
    this.name = "SliceError";
  }
}

type VendorRow = {
  id: string;
  name: string;
  role: string;
  address: string | null;
  mirror_wallet_id: string | null;
  baseline_payment_limit: string | number | null;
  notice_email: string | null;
  jurisdiction: string | null;
  purchase_order_required: boolean | null;
  sample: boolean | null;
};

const addressOf = (row: Pick<VendorRow, "address" | "mirror_wallet_id">): SliceAddress => (row.mirror_wallet_id ? "mirror" : row.address ? "own" : "none");

/** The vendors a slice may carry, in the workspace in scope: never sample data, by name. */
export async function sliceVendors(orgDb: OrgDb): Promise<SliceVendor[]> {
  const rows = unwrap(
    await orgDb.from("counterparties").select("id, name, role, address, mirror_wallet_id, baseline_payment_limit, sample").eq("role", "vendor").order("name")
  ) as Array<Pick<VendorRow, "id" | "name" | "role" | "address" | "mirror_wallet_id" | "baseline_payment_limit" | "sample">>;
  return rows
    .filter((row) => row.sample !== true)
    .map((row) => ({ id: row.id, name: row.name, address: addressOf(row), paymentLimit: row.baseline_payment_limit === null ? null : Number(row.baseline_payment_limit) }));
}

/** The slice opened from the workspace in scope, with whether its workspace is live; null before there is one. */
export async function readLiveSlice(orgDb: OrgDb): Promise<LiveSlice | null> {
  const entry = (
    unwrap(await orgDb.from("ledger_entries").select("ts, detail").eq("action", LIVE_SLICE_STARTED).order("seq", { ascending: false }).limit(1)) as Array<{
      ts: string;
      detail: Record<string, unknown>;
    }>
  )[0];
  const orgId = typeof entry?.detail.liveOrgId === "string" ? entry.detail.liveOrgId : null;
  if (!entry || !orgId) return null;
  // The slice's workspace is another organization: its slug, name and mode only, by the id this workspace signed.
  const org = (unwrap(await platformDb().from("orgs").select("id, slug, name, mode").eq("id", orgId).limit(1)) as Array<{ id: string; slug: string; name: string; mode: string }>)[0];
  if (!org) return null;
  return {
    orgId: org.id,
    slug: org.slug,
    name: org.name,
    live: org.mode === "live",
    startedAt: entry.ts,
    vendors: Array.isArray(entry.detail.vendors) ? entry.detail.vendors.length : 0,
  };
}

const idsSchema = z.array(z.string().uuid()).max(SLICE_MAX_VENDORS * 4);

/**
 * Opens the live slice from the workspace in scope (L2-L4). Who may (an owner) and whether Arc mainnet is open to them
 * are the caller's checks; the deployment's own mainnet switch and the workspace limit are `createWorkspace`'s.
 */
export async function startLiveSlice(input: { userId: string; vendorIds: string[] }): Promise<{ slug: string; carried: SliceVendor[]; skipped: number }> {
  const sourceOrgId = currentOrgId();
  if (workspaceNetwork().id === "arc-mainnet") throw new SliceError("mainnet_workspace");
  if (!(await readShadowMode(db()))) throw new SliceError("not_shadow");
  if (await readLiveSlice(db())) throw new SliceError("already");
  const ids = [...new Set(idsSchema.parse(input.vendorIds))];
  if (ids.length === 0) throw new SliceError("no_vendors");
  if (ids.length > SLICE_MAX_VENDORS) throw new SliceError("too_many");
  // An unreadable signing key refuses before a workspace is made, rather than leave a slice unrecorded.
  assertLedgerCanSign();

  const rows = (
    unwrap(
      await db()
        .from("counterparties")
        .select("id, name, role, address, mirror_wallet_id, baseline_payment_limit, notice_email, jurisdiction, purchase_order_required, sample")
        .eq("role", "vendor")
        .in("id", ids)
    ) as VendorRow[]
  ).filter((row) => row.sample !== true);
  const carry = rows.filter((row) => row.baseline_payment_limit !== null && Number(row.baseline_payment_limit) > 0);
  if (carry.length === 0) throw new SliceError("no_vendors");

  const source = (unwrap(await platformDb().from("orgs").select("name").eq("id", sourceOrgId).limit(1)) as Array<{ name: string }>)[0];
  const name = `${(source?.name ?? "Workspace").slice(0, 49).trim()} live slice`;
  let made: { orgId: string; slug: string };
  try {
    made = await createWorkspace({ userId: input.userId, name, network: "arc-mainnet" });
  } catch (error) {
    if (error instanceof WorkspaceLimitError) throw new SliceError("limit");
    throw error;
  }

  // Each vendor through the one way a counterparty is added, in the new workspace's scope. Its own address waits for a
  // person there (`via: "live_slice"`); a mirror address is never carried.
  const carried: SliceVendor[] = [];
  await withOrg(
    made.orgId,
    async () => {
      for (const row of carry) {
        const address = addressOf(row);
        // Through the console's own checks: the address's checksum, the limit as an amount; the workspace's own chain, ARC.
        const counterparty = counterpartyInputSchema.parse({
          name: row.name,
          role: "vendor",
          address: address === "own" ? (row.address ?? "") : "",
          jurisdiction: row.jurisdiction ?? "",
          paymentLimit: String(Number(row.baseline_payment_limit)),
          noticeEmail: row.notice_email ?? undefined,
        });
        await createCounterparty({
          actorId: input.userId,
          counterparty,
          via: "live_slice",
          liveSlice: { fromOrgId: sourceOrgId, fromCounterpartyId: row.id },
          ...(row.purchase_order_required === null ? {} : { purchaseOrderRequired: row.purchase_order_required }),
        });
        carried.push({ id: row.id, name: row.name, address, paymentLimit: Number(row.baseline_payment_limit) });
      }
    },
    { userId: input.userId }
  );

  await appendLedgerEntry({
    actor: "human",
    domain: "system",
    action: LIVE_SLICE_STARTED,
    summary: `Opened a live slice on Arc mainnet, ${made.slug}, with ${carried.length} ${carried.length === 1 ? "vendor" : "vendors"}`,
    detail: {
      by: input.userId,
      liveOrgId: made.orgId,
      liveSlug: made.slug,
      vendors: carried.map((vendor) => ({ counterpartyId: vendor.id, name: vendor.name, address: vendor.address })),
      skipped: rows.length - carry.length,
    },
  });
  return { slug: made.slug, carried, skipped: rows.length - carry.length };
}
