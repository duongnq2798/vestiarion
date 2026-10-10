import { orgHref } from "@/lib/auth/org-paths";
import { networkProfile } from "@/lib/network";
import { DOCS_LINK, NAV_GROUPS, NAV_ITEMS, sectionPathOf, type NavKey } from "./nav";
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
  treasury: ["home", "console", "overview", "balance", "cash", "reserve", "forecast", "pause", "resume"],
  approvals: ["inbox", "held", "approve", "pay", "reject", "return", "decide", "verdict"],
  invoices: ["invoices", "payables", "receivables", "bills", "ap", "ar"],
  counterparties: ["vendors", "clients", "suppliers", "payees"],
  contractors: ["milestones", "freelancers", "work"],
  compliance: ["screening", "sanctions", "risk", "limits"],
  audit: ["ledger", "log", "hash", "signatures", "chain"],
  insights: ["charts", "metrics", "measurements", "fees", "settlement"],
  report: ["impact", "summary", "results", "outcomes", "proof", "discounts", "readiness"],
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

/** The sections in the sidebar's groups, for the palette's headings; the unlabelled first group reads "Go to". */
export function sectionGroups(slug: string): Array<{ heading: string; targets: Array<CommandTarget & { key: NavKey }> }> {
  const targets = sectionTargets(slug);
  return NAV_GROUPS.map((group) => ({
    heading: group.hideLabel ? "Go to" : group.label,
    targets: group.items.map((item) => targets.find((target) => target.key === item.key) as CommandTarget & { key: NavKey }),
  }));
}

/**
 * Shortcuts to places that already exist (workspace shell design S9): each opens a page, a form on it, or a section of
 * Settings, where the page's own controls and permissions take over. None of them does anything by itself.
 */
export function quickActions(workspace: WorkspaceSummary): CommandTarget[] {
  const slug = workspace.slug;
  const actions: CommandTarget[] = [
    { id: "action:add-bill", label: "Add a bill", href: orgHref(slug, "/invoices?add=1"), keywords: ["new invoice", "payable", "upload", "import", "csv", "document"] },
    { id: "action:add-counterparty", label: "Add a counterparty", href: orgHref(slug, "/counterparties?add=1"), keywords: ["new supplier", "vendor", "payee", "client"] },
    { id: "action:spending-limit", label: "Agent spending limit", href: orgHref(slug, "/console#agent-budget"), keywords: ["budget", "daily limit", "cap", "change limit"] },
  ];
  // Shadow mode exists on Arc testnet only.
  if (workspace.network !== "arc-mainnet") {
    actions.push({ id: "action:shadow-mode", label: "Shadow mode", href: orgHref(slug, "/settings#shadow-mode-title"), keywords: ["verdict", "agree", "mirror", "trial"] });
  }
  if (workspace.mode !== "live") {
    actions.push({ id: "action:go-live", label: "Go live", href: orgHref(slug, "/settings#go-live-title"), keywords: ["wallet", "fund", "launch", "live"] });
  }
  return actions;
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
