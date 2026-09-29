import type { IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import type { WorkspaceSummary } from "@/components/vx/workspace";
import type { Member, OpenInvitation } from "@/lib/platform/members";

/**
 * Made-up data for the screens on /design. Typed by the real interfaces, so a
 * change to their shape breaks the build here too. Nothing reads or writes a
 * database: the slugs name no real workspace, and the server actions refuse
 * them without a signed-in member.
 */

export const DESIGN_SLUG = "design-demo";

export const WORKSPACE: WorkspaceSummary = { slug: DESIGN_SLUG, name: "Acme Treasury", mode: "live", role: "owner" };

export const WORKSPACES: WorkspaceSummary[] = [
  WORKSPACE,
  { slug: "design-sandbox", name: "Note One", mode: "sandbox", role: "admin" },
  { slug: "design-studio", name: "Studio Payables", mode: "sandbox", role: "viewer" },
];

export const EMAIL = "ada@example.com";

export const COUNTERPARTIES: IntakeCounterparty[] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Northwind Supply", role: "vendor" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Grace Hopper Studio", role: "contractor" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Contoso Retail", role: "client" },
];

export const MEMBERS: Member[] = [
  { userId: "design-ada", email: EMAIL, role: "owner", joinedAt: "2026-09-24T09:00:00Z" },
  { userId: "design-grace", email: "grace@example.com", role: "admin", joinedAt: "2026-09-27T14:30:00Z" },
  { userId: "design-alan", email: "alan@example.com", role: "viewer", joinedAt: "2026-09-28T08:15:00Z" },
];

export const INVITATIONS: OpenInvitation[] = [
  { id: "design-invite-1", email: "katherine@example.com", role: "approver", expiresAt: "2026-10-05T00:00:00Z" },
  { id: "design-invite-2", email: "edsger@example.com", role: "viewer", expiresAt: "2026-10-06T00:00:00Z" },
];
