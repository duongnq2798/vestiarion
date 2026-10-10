/**
 * The workspace's sections, in the order and groups the navigation shows
 * them. Pure data, free of React: the sidebar, the mobile drawer, the command
 * palette and `tests/navigation.test.ts` all read this one list, and each
 * page's title is its label here — so a section cannot be added, renamed or
 * removed in one place and left stale in another.
 *
 * The first group has no visible heading: Treasury and Approvals, where a
 * workspace opens and where a person decides what the agent would not pay on
 * its own (workspace shell design S1). Its label still names the group for a
 * screen reader.
 */
export const NAV_GROUPS = [
  {
    label: "Home",
    hideLabel: true,
    items: [
      { key: "treasury", path: "/console", label: "Treasury" },
      { key: "approvals", path: "/approvals", label: "Approvals" },
    ],
  },
  {
    label: "Operations",
    hideLabel: false,
    items: [
      { key: "invoices", path: "/invoices", label: "Bills & receivables" },
      { key: "counterparties", path: "/counterparties", label: "Counterparties" },
      { key: "contractors", path: "/contractors", label: "Contractors" },
    ],
  },
  {
    label: "Controls",
    hideLabel: false,
    items: [
      { key: "compliance", path: "/compliance", label: "Compliance" },
      { key: "audit", path: "/audit", label: "Audit log" },
    ],
  },
  {
    label: "Analytics",
    hideLabel: false,
    items: [
      { key: "insights", path: "/insights", label: "Insights" },
      { key: "report", path: "/report", label: "Report" },
    ],
  },
  {
    label: "Workspace",
    hideLabel: false,
    items: [
      { key: "members", path: "/members", label: "Members" },
      { key: "settings", path: "/settings", label: "Settings" },
    ],
  },
] as const;

export type NavGroup = (typeof NAV_GROUPS)[number];
export type NavItem = NavGroup["items"][number];
export type NavKey = NavItem["key"];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap<NavItem>((group) => group.items);

/**
 * The public developer docs: not a workspace section, so outside `NAV_GROUPS`,
 * and linked quietly at the foot of the navigation panel.
 */
export const DOCS_LINK = { href: "/docs", label: "Docs" } as const;

/** Where a workspace opens: its first section. */
export const HOME_PATH = NAV_ITEMS[0].path;

/** The section a workspace pathname is in: `/o/acme/audit` → Audit log. */
export function navItemForPathname(pathname: string): NavItem | undefined {
  const section = /^\/o\/[^/]+(\/[^/]+)/.exec(pathname)?.[1];
  return NAV_ITEMS.find((item) => item.path === section);
}

/** The section the URL is in, or the workspace's home — where a switch to another workspace lands. */
export function sectionPathOf(pathname: string): string {
  return navItemForPathname(pathname)?.path ?? HOME_PATH;
}

/** A section's label, which is also its page title. */
export function sectionTitle(key: NavKey): string {
  const item = NAV_ITEMS.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`no navigation section ${key}`);
  return item.label;
}
