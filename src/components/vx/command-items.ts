import { orgHref } from "@/lib/auth/org-paths";
import { networkProfile } from "@/lib/network";
import { DOCS_LINK, NAV_ITEMS, sectionPathOf, type NavKey } from "./nav";
import type { WorkspaceSummary } from "./workspace";
import { workspaceStanding } from "./WorkspaceMeta";

/**
 * What the command palette offers, as plain data: pure, so the targets and
 * their search words are tested without a browser.
 */

export interface CommandTarget {
  id: string;
  label: string;
  href: string;
  /** Extra words the palette's filter matches, beside the label. */
  keywords: string[];
}

/** The words people use for a section when its label is not the word in their head. */
const SECTION_KEYWORDS: Record<NavKey, string[]> = {
  treasury: ["home", "console", "balance", "cash", "reserve", "forecast", "pause", "resume"],
  insights: ["charts", "metrics", "measurements", "fees", "settlement"],
  report: ["impact", "summary", "results", "outcomes", "proof", "discounts", "readiness"],
  invoices: ["invoices", "payables", "receivables", "bills", "ap", "ar"],
  counterparties: ["vendors", "clients", "suppliers", "payees"],
  contractors: ["milestones", "freelancers", "work"],
  approvals: ["inbox", "held", "approve", "pay", "reject", "return", "decide"],
  compliance: ["screening", "sanctions", "risk", "limits"],
  audit: ["ledger", "log", "hash", "signatures", "chain"],
  members: ["team", "people", "invite", "roles"],
  settings: ["api keys", "api", "tokens", "developer", "integrations"],
};

export function sectionTargets(slug: string): Array<CommandTarget & { key: NavKey }> {
  return NAV_ITEMS.map((item) => ({
    id: `section:${item.key}`,
    key: item.key,
    label: item.label,
    href: orgHref(slug, item.path),
    keywords: SECTION_KEYWORDS[item.key],
  }));
}

/** The public developer docs: the API reference, webhooks and keys, outside any workspace. */
export const DOCS_TARGET: CommandTarget = {
  id: "developer-docs",
  label: "Developer docs",
  href: DOCS_LINK.href,
  keywords: ["docs", "documentation", "api", "reference", "webhooks", "developers", "help"],
};

/** Every other workspace, opened on the section the person is looking at now. */
export function workspaceTargets(current: WorkspaceSummary, workspaces: readonly WorkspaceSummary[], pathname: string): CommandTarget[] {
  const section = sectionPathOf(pathname);
  return workspaces
    .filter((workspace) => workspace.slug !== current.slug)
    .map((workspace) => ({
      id: `workspace:${workspace.slug}`,
      label: workspace.name,
      href: orgHref(workspace.slug, section),
      keywords: [workspace.slug, workspace.mode, workspace.role, workspaceStanding(workspace.mode, workspace.network), networkProfile(workspace.network).label],
    }));
}

/** "⌘K" on Apple platforms, "Ctrl K" everywhere else — and on the server, which cannot know. */
export function shortcutLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}
