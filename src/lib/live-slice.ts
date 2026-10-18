import { z } from "zod";
import { createCounterparty, type CounterpartyInput } from "./counterparties/create";
import { currentOrgId } from "./context";
import { addressUnconfirmed } from "./counterparty-address";
import { db, platformDb, unwrap, type OrgDb } from "./dal";
import { withOrg } from "./dal/scope";
import { counterpartyInputSchema } from "./intake-validation";
import { appendLedgerEntry, assertLedgerCanSign } from "./ledger";
import { homeChain } from "./payee-chains";
import { createWorkspace, WorkspaceLimitError } from "./platform/workspace";
import { readShadowMode } from "./shadow-mode";
import { workspaceNetwork } from "./workspace-network";

/**
 * Start the live slice (docs/superpowers/specs/2026-10-18-live-slice-design.md L1-L6): from a workspace in shadow mode on
 * Arc testnet, an owner opens a workspace on Arc mainnet, owned by them and made by the usual `createWorkspace`, with the
 * vendors they chose carried over. A vendor's own confirmed Arc address is carried and waits for a person to confirm it
 * there; a mirror address, an address on another chain and one still waiting for confirmation here never are. No bill,
 * history or verdict is carried, and the new workspace is not live: going live is the business's next step. The shadow
 * workspace signs `live_slice_started`.
 */

export const LIVE_SLICE_STARTED = "live_slice_started";
/** The most vendors one slice carries. */
export const SLICE_MAX_VENDORS = 25;

/**
 * How a vendor's address goes over (L3): its own confirmed Arc address is carried; a mirror address (a wallet of this
 * workspace's on Arc testnet), an address on another chain, one not confirmed here, or none, is not.
 */
export type SliceAddress = "own" | "mirror" | "other_chain" | "unconfirmed" | "none";

export interface SliceVendor {
  id: string;
  name: string;
  address: SliceAddress;
  /** The payment limit the business set; a vendor without one is not carried (L3). */
  paymentLimit: number | null;
}

/** Why a chosen vendor stayed in the shadow workspace (L3): no payment limit, details the checks refuse, or not added. */
export type SliceSkipReason = "no_limit" | "not_valid" | "not_added";

export interface SliceSkipped {
  counterpartyId: string;
  name: string;
  reason: SliceSkipReason;
}

export interface LiveSlice {
  orgId: string;
  slug: string;
  name: string;
  live: boolean;
  startedAt: string;
  /** Who started it: at first the only member of the new workspace. */
  by: string | null;
  vendors: number;
  skipped: Array<{ name: string; reason: SliceSkipReason }>;
}

export type SliceErrorCode = "not_shadow" | "mainnet_workspace" | "no_vendors" | "too_many" | "already" | "limit" | "unrecorded";

export const SLICE_MESSAGES: Record<SliceErrorCode, string> = {
  not_shadow: "A live slice starts from a workspace in shadow mode.",
  mainnet_workspace: "This workspace is on Arc mainnet already.",
  no_vendors: "Choose at least one vendor with a payment limit to pay for real.",
  too_many: `Choose at most ${SLICE_MAX_VENDORS} vendors for a first slice.`,
  already: "A live slice was opened from this workspace already. Open it from the report.",
  limit: "You already have 3 workspaces on Arc mainnet, the most one person can create there.",
  unrecorded: "The workspace on Arc mainnet was opened, but this workspace could not record it. Open it from your workspaces rather than starting another.",
};

export class SliceError extends Error {
  /** With `unrecorded`: the workspace that was opened. */
  slug?: string;

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
  chain: string | null;
  address_changed_at: string | null;
  address_confirmed_at: string | null;
  mirror_wallet_id: string | null;
  baseline_payment_limit: string | number | null;
  notice_email: string | null;
  jurisdiction: string | null;
  purchase_order_required: boolean | null;
  sample: boolean | null;
};

const ADDRESS_COLUMNS = "address, chain, address_changed_at, address_confirmed_at, mirror_wallet_id";

type AddressRow = Pick<VendorRow, "address" | "chain" | "address_changed_at" | "address_confirmed_at" | "mirror_wallet_id">;

/** How a vendor's address would go over, from the workspace in scope (L3). */
function addressOf(row: AddressRow): SliceAddress {
  if (row.mirror_wallet_id) return "mirror";
  if (!row.address) return "none";
  // Paid on another chain through CCTP or Gateway: the same address may not be the vendor's on Arc mainnet.
  if (row.chain !== null && row.chain !== homeChain(workspaceNetwork().id).id) return "other_chain";
  // Sent through a payee link or changed, and no person has confirmed it yet: not one to carry as the vendor's.
  if (addressUnconfirmed(row.address_changed_at, row.address_confirmed_at)) return "unconfirmed";
  return "own";
}

const limitOf = (row: Pick<VendorRow, "baseline_payment_limit">): number | null =>
  row.baseline_payment_limit === null || !(Number(row.baseline_payment_limit) > 0) ? null : Number(row.baseline_payment_limit);

/** The vendors a slice may carry, in the workspace in scope: never sample data, by name. */
export async function sliceVendors(orgDb: OrgDb): Promise<SliceVendor[]> {
  const rows = unwrap(
    await orgDb.from("counterparties").select(`id, name, role, ${ADDRESS_COLUMNS}, baseline_payment_limit, sample`).eq("role", "vendor").order("name")
  ) as Array<Pick<VendorRow, "id" | "name" | "role" | "baseline_payment_limit" | "sample"> & AddressRow>;
  return rows.filter((row) => row.sample !== true).map((row) => ({ id: row.id, name: row.name, address: addressOf(row), paymentLimit: limitOf(row) }));
}

const SKIP_REASONS: ReadonlySet<string> = new Set<SliceSkipReason>(["no_limit", "not_valid", "not_added"]);

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
  const skipped = Array.isArray(entry.detail.skipped) ? (entry.detail.skipped as Array<Record<string, unknown>>) : [];
  return {
    orgId: org.id,
    slug: org.slug,
    name: org.name,
    live: org.mode === "live",
    startedAt: entry.ts,
    by: typeof entry.detail.by === "string" ? entry.detail.by : null,
    vendors: Array.isArray(entry.detail.vendors) ? entry.detail.vendors.length : 0,
    skipped: skipped.flatMap((row) =>
      typeof row.name === "string" && typeof row.reason === "string" && SKIP_REASONS.has(row.reason) ? [{ name: row.name, reason: row.reason as SliceSkipReason }] : []
    ),
  };
}

const idsSchema = z.array(z.string().uuid()).max(SLICE_MAX_VENDORS * 4);

/**
 * Opens the live slice from the workspace in scope (L2-L4). Who may (an owner) and whether Arc mainnet is open to them
 * are the caller's checks; the deployment's own mainnet switch and the workspace limit are `createWorkspace`'s.
 *
 * Once the workspace is made, every vendor was checked already, one that still fails to be added is left behind and
 * named, and only a failure to sign at the very end leaves the slice unrecorded here, which the caller is told about with
 * the workspace's slug (`unrecorded`), rather than invite another.
 */
export async function startLiveSlice(input: {
  userId: string;
  vendorIds: string[];
}): Promise<{ slug: string; carried: SliceVendor[]; skipped: SliceSkipped[] }> {
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
        .select(`id, name, role, ${ADDRESS_COLUMNS}, baseline_payment_limit, notice_email, jurisdiction, purchase_order_required, sample`)
        .eq("role", "vendor")
        .in("id", ids)
    ) as VendorRow[]
  ).filter((row) => row.sample !== true);

  // Each vendor through the console's own checks before anything is made (the address's checksum, the limit as an
  // amount; the new workspace's own chain, ARC), so one the checks refuse is left behind rather than half carried.
  const skipped: SliceSkipped[] = [];
  const carry: Array<{ row: VendorRow; address: SliceAddress; counterparty: CounterpartyInput; limit: number }> = [];
  for (const row of rows) {
    const limit = limitOf(row);
    if (limit === null) {
      skipped.push({ counterpartyId: row.id, name: row.name, reason: "no_limit" });
      continue;
    }
    const address = addressOf(row);
    const parsed = counterpartyInputSchema.safeParse({
      name: row.name,
      role: "vendor",
      address: address === "own" ? (row.address ?? "") : "",
      jurisdiction: row.jurisdiction ?? "",
      paymentLimit: String(limit),
      noticeEmail: row.notice_email ?? undefined,
    });
    if (parsed.success) carry.push({ row, address, counterparty: parsed.data, limit });
    else skipped.push({ counterpartyId: row.id, name: row.name, reason: "not_valid" });
  }
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
  // person there (`via: "live_slice"`). One that fails is left behind and named; the rest still go.
  const carried: SliceVendor[] = [];
  await withOrg(
    made.orgId,
    async () => {
      for (const { row, address, counterparty, limit } of carry) {
        try {
          await createCounterparty({
            actorId: input.userId,
            counterparty,
            via: "live_slice",
            liveSlice: { fromOrgId: sourceOrgId, fromCounterpartyId: row.id },
            ...(row.purchase_order_required === null ? {} : { purchaseOrderRequired: row.purchase_order_required }),
          });
          carried.push({ id: row.id, name: row.name, address, paymentLimit: limit });
        } catch (error) {
          console.error("live slice: a vendor was not added", made.orgId, row.id, error instanceof Error ? error.message : "unknown error");
          skipped.push({ counterpartyId: row.id, name: row.name, reason: "not_added" });
        }
      }
    },
    { userId: input.userId }
  );

  try {
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
        skipped,
      },
    });
  } catch (error) {
    console.error("live slice: opened but not recorded", sourceOrgId, made.orgId, error instanceof Error ? error.message : "unknown error");
    const unrecorded = new SliceError("unrecorded");
    unrecorded.slug = made.slug;
    throw unrecorded;
  }
  return { slug: made.slug, carried, skipped };
}
