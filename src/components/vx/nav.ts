/**
 * The workspace's sections, in the order and groups the navigation shows
 * them. Pure data, free of React: the sidebar, the mobile drawer and
 * `tests/navigation.test.ts` all read this one list, and each page's title
 * is its label here — so a section cannot be added, renamed or removed in one
 * place and left stale in another.
 */
export const NAV_GROUPS = [
  {
    label: "Overview",
    items: [
      { key: "treasury", path: "/console", label: "Treasury" },
      { key: "insights", path: "/insights", label: "Insights" },
    ],
  },
  {
    label: "Operations",
    items: [
      { key: "invoices", path: "/invoices", label: "AP / AR" },
      { key: "counterparties", path: "/counterparties", label: "Counterparties" },
      { key: "contractors", path: "/contractors", label: "Contractors" },
    ],
  },
  {
    label: "Controls",
    items: [
      { key: "approvals", path: "/approvals", label: "Approvals" },
      { key: "compliance", path: "/compliance", label: "Compliance" },
      { key: "audit", path: "/audit", label: "Audit log" },
      { key: "members", path: "/members", label: "Members" },
    ],
  },
] as const;

export type NavItem = (typeof NAV_GROUPS)[number]["items"][number];
export type NavKey = NavItem["key"];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap<NavItem>((group) => group.items);

/** Where a workspace opens: its first section. */
export const HOME_PATH = NAV_ITEMS[0].path;

/** The section a workspace pathname is in: `/o/acme/audit` → Audit log. */
export function navItemForPathname(pathname: string): NavItem | undefined {
  const section = /^\/o\/[^/]+(\/[^/]+)/.exec(pathname)?.[1];
  return NAV_ITEMS.find((item) => item.path === section);
}

/** A section's label, which is also its page title. */
export function sectionTitle(key: NavKey): string {
  const item = NAV_ITEMS.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`no navigation section ${key}`);
  return item.label;
}
