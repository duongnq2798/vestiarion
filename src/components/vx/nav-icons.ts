import { ChartLine, ClipboardList, FileText, Flag, Inbox, KeyRound, Landmark, ScrollText, ShieldCheck, UserCog, Users, type LucideIcon } from "lucide-react";
import type { NavKey } from "./nav";

/**
 * One icon per workspace section. A `Record` over every key, so a section
 * added to `nav.ts` without an icon does not compile — which is how Members
 * once rendered an empty square.
 */
export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  treasury: Landmark,
  insights: ChartLine,
  report: ClipboardList,
  invoices: FileText,
  counterparties: Users,
  contractors: Flag,
  approvals: Inbox,
  compliance: ShieldCheck,
  audit: ScrollText,
  members: UserCog,
  settings: KeyRound,
};
