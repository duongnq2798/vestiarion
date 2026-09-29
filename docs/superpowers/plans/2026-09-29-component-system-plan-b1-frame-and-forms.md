# Component system — Plan B1: the workspace frame, public chrome, forms and members

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a person clicks or types into moves onto the design system: the workspace navigation (sidebar, drawer, workspace switcher, account menu, ⌘K command palette), the public pages' header, footer and landing page, every form (sign-in, workspaces, invitations, intake, milestones) and the members panel.

**Architecture:** Screens compose the primitives in `src/components/ui/` (merged in #23). Navigation state stays client-side in `src/components/vx/AppNav.tsx` and a new `CommandPalette.tsx` context; the frame stays a server component that hands them platform data only. Every form submits through `useActionForm`, so a refused submission keeps what was typed. `/design` gains a "Screens" section rendering these real components with fixture data (spec P11).

**Tech Stack:** Next.js 16.3.6, React 19.2.8, Tailwind 4.3, radix-ui 1.6.7, motion 13.4.4, sonner 2.0.8, cmdk 1.1.1, lucide-react 1.48.0, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-28-component-system-design.md` — §4–§7 and §13 (P2–P5, P10, P11 bind this plan; §13 wins where it differs).

## Global Constraints

- Work only in `E:\APP2028\hackathon-project-ui`, branch `feat/component-migration` (from `b831b81`). Never run commands in `E:\APP2028\hackathon-project`.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). In this Next version a layout is not a gate: every `/o/[slug]` page keeps calling `requireMembership` itself (tests pin it).
- No new dependencies. `npm run verify` is green at every commit.
- Import primitives directly from `@/components/ui/<Name>`. Outside `src/components/ui/`, render no raw `<button>`, `<select>`, `<textarea>`, or non-hidden `<input>` (Plan B2's test enforces it; B1 must already comply in every file it touches). `<input type="hidden">`, `<a>`/`Link`, `<form>` and `<label>` are fine.
- Colours only from the brand tokens (`bg-agent`, `text-ink-3`, `border-line`, … with `/opacity`); no hex/`rgb()`/`hsl()`/`oklch()` in `.tsx`; no Tailwind default palette; no `white`/`black` utilities.
- Radius by role: `rounded-md` tags, chips, `Kbd`; `rounded-lg` menu items and `sm` controls; `rounded-xl` `md`/`lg` buttons and fields, callouts, menu surfaces; `rounded-2xl` cards and dialogs; `rounded-full` pills and avatars. No `rounded`, `rounded-sm`, `rounded-3xl` or arbitrary radii in files you touch.
- Shadows only `shadow-control|surface|raised|overlay|brand`; the logo uses `drop-shadow-logo`. Do not use the old `surface-shadow`, `brand-shadow`, `logo-shadow` utilities in files you touch (B2 deletes them).
- Motion: hover and press `duration-150 ease-standard`; Motion values from `MOTION` in `@/components/ui/tokens`; `m.*` components only (LazyMotion is `strict`).
- Feedback: a success that keeps the person on the page raises a toast (`toastOnSuccess`); an action's error is shown inline next to the form (`FormMessage` or a `role="alert"` line), never only in a toast.
- The React Compiler lint rules are errors: no synchronous `setState` in an effect body (subscribe in the effect and set state in the callback), no `ref.current` read during render (event handlers and effects are fine).
- JSX text uses typographic apostrophes and quotes (’ “ ”). User-facing copy stays as it is except where a control needs a new label; new copy is plain and specific.
- Commit messages describe the change plainly and end with the implementing model's `Co-Authored-By` trailer.

## Review Focus

1. **A person on a phone can reach and leave the navigation**: the drawer opens from the menu button, closes on Escape, on a click outside, on following any link (including the page already open) and when the window grows past `lg`, and focus returns to the menu button. Pinned by the Task 7 browser pass (DOM checks when the pane is hidden).
2. **⌘K / Ctrl K opens the palette from anywhere in a workspace and never fights the browser**: the shortcut toggles it, `Enter` on a section navigates and closes it, typing filters by label and keywords, and the label shown next to the search button is right for the platform without a hydration warning. Pinned by `tests/command-items.test.ts` (targets, keywords, labels) and the Task 7 browser pass.
3. **A refused intake or invitation keeps what was typed and says why next to the form; a successful one clears and toasts.** Pinned by the Task 7 browser pass on `/design#screens`, where the server actions refuse without a session.
4. **Changing a member's role shows the new role while saving and the server's truth afterwards** — the previous role if the change was refused. Pinned by the `RoleCell` design (display derives from `pending`) and the Task 7 browser pass.
5. **Destructive member actions ask first and never double-submit**: remove, leave and revoke open a confirmation; the trigger shows progress and is disabled while the action runs. Pinned by the Task 7 browser pass.

## File map

| File | Change | Task |
|---|---|---|
| `src/components/vx/workspace.ts` | new: `WorkspaceSummary` type | 1 |
| `src/components/vx/nav-icons.ts` | new: typed section → lucide icon map | 1 |
| `src/components/vx/command-items.ts` | new: pure palette targets and shortcut label | 1 |
| `src/components/vx/CommandPalette.tsx` | new: provider, ⌘K, dialog, `useCommandPalette`, `useShortcutLabel` | 1 |
| `src/components/vx/AppNav.tsx` | rewrite: section nav with a gliding marker, switcher and account menus, search button, drawer | 1 |
| `src/components/vx/AppFrame.tsx` | rewrite: MotionProvider + palette provider around the frame | 1 |
| `src/app/o/[slug]/layout.tsx` | `WorkspaceSummary` import path | 1 |
| `src/components/vx/Shell.tsx` | status strip badges, page enter animation, EmptyState delegates to ui | 1 |
| `src/app/o/[slug]/loading.tsx`, `error.tsx` | Skeleton / Card / Button | 1 |
| `src/app/globals.css` | remove the `.nav-drawer` CSS | 1 |
| `tests/command-items.test.ts`, `tests/nav-icons.test.ts` | new | 1 |
| `src/components/vx/Brand.tsx`, `SiteChrome.tsx`, `SiteMenu.tsx`, `src/app/page.tsx`, `src/app/not-found.tsx`, `src/app/o/not-found.tsx` | public chrome | 2 |
| `src/components/ui/EmptyState.tsx` (+test) | `titleAs` accepts `h1` | 3 |
| `src/components/auth/LoginForm.tsx`, `src/app/login/page.tsx`, `src/components/CreateWorkspaceForm.tsx`, `src/components/AcceptInvitationForm.tsx`, `src/components/AcceptInvitationByIdForm.tsx`, `src/app/onboarding/page.tsx`, `src/app/invite/[token]/page.tsx` | auth and onboarding | 3 |
| `src/components/ui/Table.tsx` (+test) | `containerClassName` | 4 |
| `src/components/intake/*.tsx`, `src/components/MilestoneVerification.tsx`, `src/app/o/[slug]/invoices/page.tsx` (intake section) | intake | 4 |
| `src/components/MembersPanel.tsx` | members | 5 |
| `src/app/design/fixtures.ts`, `src/app/design/Screens.tsx`, `src/app/design/page.tsx` | `/design#screens` | 6 |

---

### Task 1: The workspace frame and the command palette

**Files:**
- Create: `src/components/vx/workspace.ts`, `src/components/vx/nav-icons.ts`, `src/components/vx/command-items.ts`, `src/components/vx/CommandPalette.tsx`
- Rewrite: `src/components/vx/AppNav.tsx`, `src/components/vx/AppFrame.tsx`, `src/components/vx/Shell.tsx`, `src/app/o/[slug]/loading.tsx`, `src/app/o/[slug]/error.tsx`
- Modify: `src/app/o/[slug]/layout.tsx`, `src/app/globals.css`
- Test: `tests/command-items.test.ts`, `tests/nav-icons.test.ts`

**Interfaces:**
- Consumes: `Avatar`, `Badge`, `Button`, `Card`, `cn`, `CommandDialog`/`CommandInput`/`CommandList`/`CommandEmpty`/`CommandGroup`/`CommandItem`/`CommandSeparator`, `DropdownMenu*`, `EmptyState`, `Eyebrow`, `Kbd`, `MotionProvider`, `Sheet`/`SheetTrigger`/`SheetContent`, `Skeleton`, `MOTION` (all `@/components/ui/*`); `NAV_GROUPS`, `NAV_ITEMS`, `HOME_PATH`, `navItemForPathname`, `NavKey` (`./nav`); `orgHref` (`@/lib/auth/org-paths`); `signOut` (`@/app/login/actions`).
- Produces:
  - `WorkspaceSummary { slug; name; mode: "sandbox" | "live"; role: OrgRole }` from `@/components/vx/workspace`.
  - `NAV_ICONS: Record<NavKey, LucideIcon>` from `@/components/vx/nav-icons`.
  - `sectionTargets(slug)`, `workspaceTargets(current, workspaces, pathname)`, `shortcutLabel(platform)`, `CommandTarget` from `@/components/vx/command-items`.
  - `CommandPaletteProvider({ workspace, workspaces, children })`, `useCommandPalette(): { open(): void }`, `useShortcutLabel(): string` from `@/components/vx/CommandPalette`.
  - `SectionNav({ orgSlug, layoutId })`, `WorkspaceSwitcher({ current, workspaces })`, `AccountMenu({ email })`, `NavPanel({ home, workspace, workspaces, email, layoutId })`, `MobileNav({ home, workspace, workspaces, email })` from `@/components/vx/AppNav`.
  - `AppFrame({ workspace, workspaces, email, children })` (unchanged signature).

- [ ] **Step 1: Write the failing tests**

`tests/command-items.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sectionTargets, shortcutLabel, workspaceTargets } from "@/components/vx/command-items";
import { NAV_ITEMS } from "@/components/vx/nav";
import type { WorkspaceSummary } from "@/components/vx/workspace";

const acme: WorkspaceSummary = { slug: "acme", name: "Acme", mode: "live", role: "owner" };
const sandbox: WorkspaceSummary = { slug: "note-one", name: "Note One", mode: "sandbox", role: "admin" };

describe("sectionTargets — the palette's sections", () => {
  it("offers every section of the workspace, in navigation order", () => {
    const targets = sectionTargets("acme");
    expect(targets.map((target) => target.key)).toEqual(NAV_ITEMS.map((item) => item.key));
    expect(targets[0]).toMatchObject({ label: "Treasury", href: "/o/acme/console" });
  });

  it("gives each section words to be found by beyond its label", () => {
    for (const target of sectionTargets("acme")) expect(target.keywords.length, target.key).toBeGreaterThan(0);
  });

  it("finds the invoices section by what people call invoices", () => {
    const invoices = sectionTargets("acme").find((target) => target.key === "invoices");
    expect(invoices?.keywords).toEqual(expect.arrayContaining(["payables", "receivables"]));
  });
});

describe("workspaceTargets — switching workspace from the palette", () => {
  it("offers every other workspace, landing on the same section", () => {
    expect(workspaceTargets(acme, [acme, sandbox], "/o/acme/audit")).toEqual([
      expect.objectContaining({ label: "Note One", href: "/o/note-one/audit" }),
    ]);
  });

  it("lands on the first section when the current page is none", () => {
    expect(workspaceTargets(acme, [acme, sandbox], "/o/acme")[0].href).toBe("/o/note-one/console");
  });

  it("offers nothing when the current workspace is the only one", () => {
    expect(workspaceTargets(acme, [acme], "/o/acme/console")).toEqual([]);
  });
});

describe("shortcutLabel — the key hint beside the search button", () => {
  it.each([
    ["MacIntel", "⌘K"],
    ["iPhone", "⌘K"],
    ["iPad", "⌘K"],
    ["Win32", "Ctrl K"],
    ["Linux x86_64", "Ctrl K"],
    ["", "Ctrl K"],
  ])("%s → %s", (platform, label) => {
    expect(shortcutLabel(platform)).toBe(label);
  });
});
```

`tests/nav-icons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/vx/nav";
import { NAV_ICONS } from "@/components/vx/nav-icons";

describe("section icons", () => {
  it("draws an icon for every section — Members once rendered an empty square", () => {
    for (const item of NAV_ITEMS) expect(NAV_ICONS[item.key], item.key).toBeDefined();
  });

  it("draws a different icon for each section", () => {
    const icons = NAV_ITEMS.map((item) => NAV_ICONS[item.key]);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/command-items.test.ts tests/nav-icons.test.ts`
Expected: FAIL — `Cannot find module '@/components/vx/command-items'`.

- [ ] **Step 3: Write the pure modules**

`src/components/vx/workspace.ts`:

```ts
import type { OrgRole } from "@/lib/auth/roles";

/**
 * What the workspace frame shows of one membership. Built from platform data
 * the layout already holds after `requireMembership` — never from an
 * organization's own rows.
 */
export interface WorkspaceSummary {
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  role: OrgRole;
}
```

`src/components/vx/nav-icons.ts`:

```ts
import { ChartLine, FileText, Flag, Landmark, ScrollText, ShieldCheck, UserCog, Users, type LucideIcon } from "lucide-react";
import type { NavKey } from "./nav";

/**
 * One icon per workspace section. A `Record` over every key, so a section
 * added to `nav.ts` without an icon does not compile — which is how Members
 * once rendered an empty square.
 */
export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  treasury: Landmark,
  insights: ChartLine,
  invoices: FileText,
  counterparties: Users,
  contractors: Flag,
  compliance: ShieldCheck,
  audit: ScrollText,
  members: UserCog,
};
```

`src/components/vx/command-items.ts`:

```ts
import { orgHref } from "@/lib/auth/org-paths";
import { HOME_PATH, NAV_ITEMS, navItemForPathname, type NavKey } from "./nav";
import type { WorkspaceSummary } from "./workspace";

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
  treasury: ["home", "console", "balance", "cash", "reserve", "forecast"],
  insights: ["charts", "metrics", "measurements", "fees", "settlement"],
  invoices: ["invoices", "payables", "receivables", "bills", "ap", "ar"],
  counterparties: ["vendors", "clients", "suppliers", "payees"],
  contractors: ["milestones", "freelancers", "work"],
  compliance: ["screening", "sanctions", "risk", "limits"],
  audit: ["ledger", "log", "hash", "signatures", "chain"],
  members: ["team", "people", "invite", "roles"],
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

/** Every other workspace, opened on the section the person is looking at now. */
export function workspaceTargets(current: WorkspaceSummary, workspaces: readonly WorkspaceSummary[], pathname: string): CommandTarget[] {
  const section = navItemForPathname(pathname)?.path ?? HOME_PATH;
  return workspaces
    .filter((workspace) => workspace.slug !== current.slug)
    .map((workspace) => ({
      id: `workspace:${workspace.slug}`,
      label: workspace.name,
      href: orgHref(workspace.slug, section),
      keywords: [workspace.slug, workspace.mode, workspace.role],
    }));
}

/** "⌘K" on Apple platforms, "Ctrl K" everywhere else — and on the server, which cannot know. */
export function shortcutLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/command-items.test.ts tests/nav-icons.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Write the command palette**

`src/components/vx/CommandPalette.tsx`:

```tsx
"use client";

import { LayoutGrid, LogOut, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { createContext, startTransition, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { Avatar } from "@/components/ui/Avatar";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/Command";
import { sectionTargets, shortcutLabel, workspaceTargets } from "./command-items";
import { NAV_ICONS } from "./nav-icons";
import type { WorkspaceSummary } from "./workspace";

const PaletteContext = createContext<{ open: () => void } | null>(null);

/** Opens the command palette — for the search buttons in the sidebar and the phone top bar. */
export function useCommandPalette() {
  const context = useContext(PaletteContext);
  if (!context) throw new Error("useCommandPalette must be used inside CommandPaletteProvider");
  return context;
}

const noSubscription = () => () => {};

/** The shortcut hint for this platform. The server renders "Ctrl K"; a Mac switches to "⌘K" without a hydration warning. */
export function useShortcutLabel(): string {
  return useSyncExternalStore(noSubscription, () => shortcutLabel(navigator.platform), () => shortcutLabel(""));
}

/**
 * The workspace's command palette: ⌘K or Ctrl K from anywhere in the frame,
 * or a search button. It goes somewhere — a section, another workspace, the
 * workspace list — or signs out; nothing in it moves money.
 */
export function CommandPaletteProvider({
  workspace,
  workspaces,
  children,
}: {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setOpen((current) => !current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const context = useMemo(() => ({ open: () => setOpen(true) }), []);
  const sections = sectionTargets(workspace.slug);
  const others = workspaceTargets(workspace, workspaces, pathname);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <PaletteContext.Provider value={context}>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump to a section, switch workspace or sign out">
        <CommandInput placeholder="Jump to a section, workspace or action…" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading={workspace.name}>
            {sections.map((target) => {
              const Icon = NAV_ICONS[target.key];
              return (
                <CommandItem key={target.id} value={target.id} keywords={[target.label, ...target.keywords]} onSelect={() => go(target.href)}>
                  <Icon aria-hidden />
                  {target.label}
                </CommandItem>
              );
            })}
          </CommandGroup>
          {others.length > 0 && (
            <CommandGroup heading="Switch workspace">
              {others.map((target) => (
                <CommandItem key={target.id} value={target.id} keywords={[target.label, ...target.keywords]} onSelect={() => go(target.href)}>
                  <Avatar name={target.label} tone="agent" shape="square" size="sm" />
                  {target.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup heading="Account">
            <CommandItem value="create-workspace" keywords={["Create workspace", "new", "sandbox"]} onSelect={() => go("/onboarding?new#create-workspace")}>
              <Plus aria-hidden />
              Create workspace
            </CommandItem>
            <CommandItem value="all-workspaces" keywords={["All workspaces", "switch", "list"]} onSelect={() => go("/onboarding?new")}>
              <LayoutGrid aria-hidden />
              All workspaces
            </CommandItem>
            <CommandItem
              value="sign-out"
              keywords={["Sign out", "log out", "logout"]}
              onSelect={() => {
                setOpen(false);
                startTransition(async () => {
                  await signOut();
                });
              }}
            >
              <LogOut aria-hidden />
              Sign out
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </PaletteContext.Provider>
  );
}
```

- [ ] **Step 6: Rewrite the navigation**

`src/components/vx/AppNav.tsx`:

```tsx
"use client";

import { Check, ChevronsUpDown, LayoutGrid, LogOut, Menu, Plus, Search } from "lucide-react";
import { LayoutGroup, m } from "motion/react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { startTransition, useEffect, useId, useState } from "react";
import { signOut } from "@/app/login/actions";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Kbd } from "@/components/ui/Kbd";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import { MOTION } from "@/components/ui/tokens";
import { orgHref } from "@/lib/auth/org-paths";
import { BrandMark } from "./Brand";
import { useCommandPalette, useShortcutLabel } from "./CommandPalette";
import { HOME_PATH, NAV_GROUPS, navItemForPathname } from "./nav";
import { NAV_ICONS } from "./nav-icons";
import type { WorkspaceSummary } from "./workspace";

/**
 * The client half of the workspace frame: what has to know the current URL
 * or hold open/closed state. Everything here renders from the viewer's
 * memberships, which are platform data — never an organization's own rows.
 */

/** Matches Tailwind's `lg`, where the sidebar replaces the drawer. */
const WIDE = "(min-width: 64rem)";

/**
 * The sections, grouped. The current one sits on a marker that glides to the
 * next section when the page changes; each copy of the navigation (sidebar,
 * drawer) has its own `layoutId` group, so the marker never flies between them.
 */
export function SectionNav({ orgSlug, layoutId }: { orgSlug: string; layoutId: string }) {
  const active = navItemForPathname(usePathname())?.key;
  const id = useId();

  return (
    <LayoutGroup id={layoutId}>
      <nav aria-label="Workspace sections" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-1">
        {NAV_GROUPS.map((group, index) => (
          <div key={group.label} className={index === 0 ? undefined : "mt-5"}>
            <p id={`${id}-${index}`} className="px-3 pb-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3">
              {group.label}
            </p>
            <ul aria-labelledby={`${id}-${index}`} className="space-y-0.5">
              {group.items.map((item) => {
                const current = item.key === active;
                const Icon = NAV_ICONS[item.key];
                return (
                  <li key={item.key}>
                    <Link
                      href={orgHref(orgSlug, item.path)}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-150 ease-standard lg:h-10",
                        current ? "font-semibold text-agent" : "text-ink-2 hover:bg-raised/70 hover:text-ink"
                      )}
                    >
                      {current && (
                        <>
                          <m.span layoutId="current-section" transition={MOTION.spring} aria-hidden className="absolute inset-0 rounded-lg bg-agent-soft" />
                          <m.span layoutId="current-section-bar" transition={MOTION.spring} aria-hidden className="absolute inset-y-2.5 -left-3 w-1 rounded-r-full bg-agent" />
                        </>
                      )}
                      <Icon aria-hidden strokeWidth={1.75} className="relative size-[1.125rem] shrink-0" />
                      <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
                      <PendingHint />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </LayoutGroup>
  );
}

/** A fixed-size dot that lights while its link's page is loading, so nothing shifts. */
function PendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={cn("relative size-1.5 shrink-0 rounded-full bg-agent transition-opacity duration-200", pending ? "opacity-100 motion-safe:animate-pulse" : "opacity-0")}
    />
  );
}

function WorkspaceMeta({ workspace }: { workspace: WorkspaceSummary }) {
  const live = workspace.mode === "live";
  return (
    <span className="flex items-center gap-1.5 text-xs font-normal text-ink-3">
      <span aria-hidden className={cn("size-1.5 rounded-full", live ? "bg-proof" : "border border-dashed border-ink-3")} />
      <span className={live ? "text-proof" : undefined}>{live ? "Live" : "Sandbox"}</span>
      <span aria-hidden>·</span>
      <span className="capitalize">{workspace.role}</span>
    </span>
  );
}

/**
 * The workspace in view, and a menu to move between workspaces — landing on
 * the same section of the other one — or to create another. Open even with a
 * single workspace: creating the second one starts here.
 */
export function WorkspaceSwitcher({ current, workspaces }: { current: WorkspaceSummary; workspaces: WorkspaceSummary[] }) {
  const section = navItemForPathname(usePathname())?.path ?? HOME_PATH;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          className="h-auto w-full justify-start gap-3 px-2.5 py-2 text-left font-normal shadow-none hover:text-ink active:scale-100 sm:h-auto data-[state=open]:border-agent-line"
        >
          <Avatar name={current.name} tone="agent" shape="square" size="lg" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">{current.name}</span>
            <WorkspaceMeta workspace={current} />
          </span>
          <ChevronsUpDown aria-hidden className="text-ink-3" />
          <span className="sr-only">Switch workspace</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((workspace) => {
          const isCurrent = workspace.slug === current.slug;
          return (
            <DropdownMenuItem key={workspace.slug} asChild>
              <Link href={orgHref(workspace.slug, section)} aria-current={isCurrent ? "page" : undefined} className="py-2">
                <Avatar name={workspace.name} tone="agent" shape="square" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{workspace.name}</span>
                  <WorkspaceMeta workspace={workspace} />
                </span>
                {isCurrent && (
                  <span aria-hidden className="text-agent">
                    <Check />
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* `?new` keeps /onboarding from sending a one-workspace person straight back here. */}
          <Link href="/onboarding?new#create-workspace" className="text-agent [&>svg]:text-agent">
            <Plus aria-hidden />
            Create workspace
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/onboarding?new">
            <LayoutGrid aria-hidden />
            All workspaces
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Who is signed in, and the way out. */
export function AccountMenu({ email }: { email: string | null }) {
  const label = email ?? "this account";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-start gap-3 px-2 py-1.5 text-left font-normal sm:h-auto">
          <Avatar name={email ?? "?"} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-ink-3">Signed in as</span>
            <span className="block truncate text-sm font-medium text-ink" title={email ?? undefined}>
              {label}
            </span>
          </span>
          <ChevronsUpDown aria-hidden className="text-ink-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="truncate font-sans text-xs font-normal normal-case tracking-normal">{label}</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/onboarding?new">
            <LayoutGrid aria-hidden />
            All workspaces
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          onSelect={() =>
            startTransition(async () => {
              await signOut();
            })
          }
        >
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchButton() {
  const palette = useCommandPalette();
  const shortcut = useShortcutLabel();
  return (
    <Button variant="secondary" onClick={palette.open} className="w-full justify-start gap-2.5 px-3 font-normal text-ink-3 shadow-none hover:text-ink">
      <Search aria-hidden />
      <span className="flex-1 text-left">Search or jump to…</span>
      <Kbd>{shortcut}</Kbd>
    </Button>
  );
}

/** Everything in the sidebar — and, below `lg`, in the drawer. */
export function NavPanel({
  home,
  workspace,
  workspaces,
  email,
  layoutId,
}: {
  home: string;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
  layoutId: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link href={home} className="group inline-flex items-center gap-2.5 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink hover:text-agent">
          <BrandMark className="size-8 shrink-0 text-agent drop-shadow-logo transition-transform duration-150 ease-standard group-hover:-rotate-6 group-hover:scale-105" />
          <span>Vestiarion</span>
        </Link>
      </div>
      <div className="shrink-0 space-y-2 px-3 pb-4">
        <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
        <SearchButton />
      </div>
      <SectionNav orgSlug={workspace.slug} layoutId={layoutId} />
      <div className="shrink-0 border-t border-line p-3">
        <AccountMenu email={email} />
      </div>
    </div>
  );
}

/**
 * Below `lg`: a compact bar naming the section and workspace, a drawer with
 * the same panel the sidebar shows, and the command palette's search button.
 * The drawer is open for one URL: following any link closes it without an
 * effect, and so does growing the window past `lg`.
 */
export function MobileNav({
  home,
  workspace,
  workspaces,
  email,
}: {
  home: string;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
}) {
  const pathname = usePathname();
  const section = navItemForPathname(pathname);
  const palette = useCommandPalette();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const closeWhenWide = () => {
      if (wide.matches) setOpenAt(null);
    };
    wide.addEventListener("change", closeWhenWide);
    return () => wide.removeEventListener("change", closeWhenWide);
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-surface/90 backdrop-blur-xl lg:hidden">
      <div className="flex h-14 items-center gap-1 px-2 sm:px-4">
        <Sheet open={open} onOpenChange={(next) => setOpenAt(next ? pathname : null)}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            title="Navigation"
            hideHeader
            onClick={(event) => {
              // A link to the page already open changes no URL; close anyway.
              if ((event.target as Element).closest("a[href]")) setOpenAt(null);
            }}
          >
            <NavPanel home={home} workspace={workspace} workspaces={workspaces} email={email} layoutId="drawer" />
          </SheetContent>
        </Sheet>
        <Link href={home} className="grid size-11 shrink-0 place-items-center rounded-xl">
          <BrandMark className="size-7 text-agent" />
          <span className="sr-only">Vestiarion — {workspace.name} home</span>
        </Link>
        <div className="min-w-0 flex-1 pl-1">
          <p className="truncate text-[0.9375rem] font-semibold leading-5 text-ink">{section?.label ?? workspace.name}</p>
          {section && <p className="truncate text-xs leading-4 text-ink-3">{workspace.name}</p>}
        </div>
        <Button variant="ghost" size="icon" aria-label="Search or jump to" onClick={palette.open}>
          <Search />
        </Button>
      </div>
    </header>
  );
}
```

`src/components/vx/AppFrame.tsx`:

```tsx
import type { ReactNode } from "react";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { orgHref } from "@/lib/auth/org-paths";
import { MobileNav, NavPanel } from "./AppNav";
import { CommandPaletteProvider } from "./CommandPalette";
import { HOME_PATH } from "./nav";
import type { WorkspaceSummary } from "./workspace";

/**
 * The navigation around every workspace page: a fixed sidebar from `lg` up,
 * and below it a top bar with a drawer holding the same panel. Rendered by
 * the `/o/[slug]` layout, so it stays put while pages change beneath it. The
 * command palette (⌘K / Ctrl K) and Motion's layout features live here, the
 * only part of the app that animates layout.
 *
 * It is built only from who is signed in and which workspaces they belong to
 * — platform data the layout already holds after `requireMembership`. Anything
 * read from the organization's own tables (the agent's clock, chain modes)
 * belongs to the page and is shown by `ProductShell`.
 */
export function AppFrame({
  workspace,
  workspaces,
  email,
  children,
}: {
  workspace: WorkspaceSummary;
  /** Every workspace the viewer belongs to, the current one included. */
  workspaces: WorkspaceSummary[];
  email: string | null;
  children: ReactNode;
}) {
  const home = orgHref(workspace.slug, HOME_PATH);

  return (
    <MotionProvider>
      <CommandPaletteProvider workspace={workspace} workspaces={workspaces}>
        <div className="min-h-dvh lg:pl-64">
          <div className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line/80 bg-surface/80 backdrop-blur-xl lg:block">
            <NavPanel home={home} workspace={workspace} workspaces={workspaces} email={email} layoutId="sidebar" />
          </div>
          <MobileNav home={home} workspace={workspace} workspaces={workspaces} email={email} />
          <main id="main" tabIndex={-1} className="outline-none">
            {children}
          </main>
        </div>
      </CommandPaletteProvider>
    </MotionProvider>
  );
}
```

In `src/app/o/[slug]/layout.tsx`, replace `import type { WorkspaceSummary } from "@/components/vx/AppNav";` with `import type { WorkspaceSummary } from "@/components/vx/workspace";`.

- [ ] **Step 7: Restyle the page shell, loading and error states**

`src/components/vx/Shell.tsx`:

```tsx
import { Clock } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState as EmptyStateBase } from "@/components/ui/EmptyState";
import { screeningMode } from "@/lib/compliance";
import type { CycleClockMode } from "@/lib/clock";
import { ProvenanceBar, type ProvenanceLeg } from "./Provenance";
import { ScrollToHash } from "./ScrollToHash";

/**
 * The page's side of the workspace frame: the agent's clock and what is live
 * or simulated, above the page's own content. Navigation lives in `AppFrame`,
 * drawn by the layout. Each page mounts its own shell, so its content rises
 * into place on every navigation and stays still on a refresh.
 *
 * Renders what the page hands it and reads no tenant data of its own. React
 * can render a child after the page function has returned, which is outside
 * the organization's scope, so the page loads everything inside `inOrg` and
 * passes it down rather than letting the shell fetch.
 */
export function ProductShell({
  day,
  clockMode,
  lastCycleAt,
  chainModes,
  children,
}: {
  day: number;
  clockMode: CycleClockMode;
  lastCycleAt: string | null;
  chainModes: { mode: "live" | "simulate"; earnMode: "live" | "simulate" };
  children: ReactNode;
}) {
  const legs: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: chainModes.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: chainModes.earnMode === "live" },
    { label: "Screening", detail: screeningMode() === "live" ? "OpenSanctions" : "bundled list", live: screeningMode() === "live" },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 motion-safe:animate-arrive sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <div className="mb-6 flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-3">
          <Badge size="sm" className="font-mono uppercase tracking-[0.11em] text-ink-2">
            {clockMode === "simulate" ? `Day ${day}` : "Wall clock"}
          </Badge>
          <span className="inline-flex items-center gap-1.5">
            <Clock aria-hidden className="size-3.5" />
            {lastCycleAt ? `Last cycle ${new Date(lastCycleAt).toLocaleString()}` : "No cycle recorded yet"}
          </span>
        </p>
        <ProvenanceBar legs={legs} compact />
      </div>
      {children}
      <ScrollToHash />
      <footer className="mt-12 flex justify-center">
        <Badge size="sm" className="bg-surface/80 font-mono font-normal text-ink-3">
          Hash-chained decisions · Ed25519 signed · Arc testnet
        </Badge>
      </footer>
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-5 border-b border-line pb-6 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-ink sm:text-3xl">{title}</h1>
        {sub && <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/** Kept for the pages Plan B2 moves over; new code imports `EmptyState` from `@/components/ui/EmptyState`. */
export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return <EmptyStateBase title={title} body={body} titleAs="h2" />;
}
```

`src/app/o/[slug]/loading.tsx`:

```tsx
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Shown the moment a section link is followed, while the page gathers its
 * data; the navigation around it stays in place. Same frame and spacing as
 * `ProductShell`, so the page lands without a jump.
 */
export default function WorkspaceLoading() {
  return (
    <div aria-busy="true" className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <p role="status" className="sr-only">
        Loading…
      </p>
      <div className="mb-6 flex flex-wrap gap-2">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-48 rounded-full" />
      </div>
      <div className="mb-8 border-b border-line pb-6">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      </div>
      <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <Card key={tile} className="h-28 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-6 w-32" />
          </Card>
        ))}
      </div>
      <div className="space-y-4">
        {[0, 1].map((card) => (
          <Card key={card} className="p-5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="mt-3 h-5 w-3/5" />
            <Skeleton className="mt-5 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-4/5" />
          </Card>
        ))}
      </div>
    </div>
  );
}
```

`src/app/o/[slug]/error.tsx`:

```tsx
"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Eyebrow } from "@/components/ui/Eyebrow";

/**
 * A page that fails to load fails inside the workspace, not instead of it:
 * the navigation stays, so every other section is still one click away.
 * In production the message from a server error is generic; the digest is
 * what matches it to the server's log.
 */
export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <Card tone="refused" role="alert" className="max-w-2xl p-6 sm:p-8">
        <Eyebrow className="text-refused">Something went wrong</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">This section could not be shown</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          Try this section again, or choose another one from the navigation — the rest of the workspace is still available.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button icon={<RotateCcw />} onClick={() => retry()}>
            Try again
          </Button>
          {error.digest && <span className="font-mono text-xs text-ink-3">Server log reference {error.digest}</span>}
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 8: Delete the old drawer CSS**

In `src/app/globals.css`: delete the rule `html:has(.nav-drawer[open]) { overflow: hidden; }` together with its comment line (“The workspace drawer is modal…”) inside `@layer base`, and inside `@layer components` delete the comment that begins “The workspace navigation below `lg`: a modal <dialog>…” and every `.nav-drawer` rule after it, including the `@starting-style { … }` block. Keep the `[data-reveal]` rules. Radix's Sheet now handles the scroll lock, the backdrop and the motion.

- [ ] **Step 9: Verify, build and commit**

```bash
npx vitest run tests/command-items.test.ts tests/nav-icons.test.ts tests/navigation.test.ts tests/access-gates.test.ts
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add src/components/vx/workspace.ts src/components/vx/nav-icons.ts src/components/vx/command-items.ts src/components/vx/CommandPalette.tsx src/components/vx/AppNav.tsx src/components/vx/AppFrame.tsx src/components/vx/Shell.tsx "src/app/o/[slug]/layout.tsx" "src/app/o/[slug]/loading.tsx" "src/app/o/[slug]/error.tsx" src/app/globals.css tests/command-items.test.ts tests/nav-icons.test.ts
git commit -m "feat(ui): the workspace frame on the design system, with a command palette

The workspace switcher and the account menu are dropdown menus, the phone
drawer is a sheet, every section has an icon, and the current section sits
on a marker that glides between sections. Cmd/Ctrl K opens a palette that
jumps to a section or another workspace, or signs out.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

Expected: tests pass; build succeeds.

---

### Task 2: The public pages' chrome and the landing page

**Files:**
- Rewrite: `src/components/vx/Brand.tsx`, `src/components/vx/SiteChrome.tsx`, `src/components/vx/SiteMenu.tsx`, `src/app/page.tsx`, `src/app/not-found.tsx`, `src/app/o/not-found.tsx`

**Interfaces:**
- Consumes: `Button`, `Card`, `cn`, `Eyebrow`, `Reveal`, `Sheet`/`SheetClose`/`SheetContent`/`SheetTrigger`, `Skeleton`, `SubmitButton` (`@/components/ui/*`); `ProvenanceBar`, `fmt` (vx, unchanged in B1).
- Produces: `SiteHeader({ landing?, children? })`, `SiteFooter({ compact? })`, `LANDING_SECTIONS` (unchanged signatures); `SiteMenu({ links })`; `BrandMark({ className? })`.

- [ ] **Step 1: The brand mark takes its colours from the tokens**

In `src/components/vx/Brand.tsx`, replace `stroke="var(--color-on-agent, #fffefa)"` with `stroke="var(--color-on-agent)"` and `fill="var(--color-proof, #13845f)"` with `fill="var(--color-proof)"`. (The fallbacks were hex literals, and the tokens are always defined.)

- [ ] **Step 2: Header, footer and the landing menu**

`src/components/vx/SiteChrome.tsx`:

```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { BrandMark } from "./Brand";
import { SiteMenu } from "./SiteMenu";

/**
 * The header and footer of the pages outside a workspace: the landing page,
 * sign-in, the workspace chooser and the not-found pages. Inside a workspace
 * the navigation is `AppFrame`'s.
 */

/** The landing page's own sections, which its header and footer link to. */
export const LANDING_SECTIONS = [
  { href: "#measurements", label: "Measurements" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#proof", label: "Proof" },
] as const;

function Wordmark() {
  return (
    <Link href="/" className="group inline-flex shrink-0 items-center gap-2.5 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink">
      <BrandMark className="size-9 shrink-0 text-agent drop-shadow-logo transition-transform duration-150 ease-standard group-hover:-rotate-6 group-hover:scale-105" />
      <span>Vestiarion</span>
    </Link>
  );
}

/** `landing` adds the section links, sign-in and the console call to action; `children` fill the right side otherwise. */
export function SiteHeader({ landing = false, children }: { landing?: boolean; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-surface/88 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Wordmark />
        {landing && (
          <nav aria-label="Site" className="mx-auto hidden md:block">
            <ul className="flex items-center gap-1">
              {LANDING_SECTIONS.map((section) => (
                <li key={section.href}>
                  <a href={section.href} className="rounded-lg px-3 py-2 text-sm text-ink-2 transition-colors duration-150 ease-standard hover:bg-raised/70 hover:text-ink">
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={landing ? "ml-auto flex items-center gap-2 md:ml-0" : "ml-auto flex items-center gap-2"}>
          {landing ? (
            <>
              <Button asChild variant="ghost" className="hidden md:inline-flex">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild className="hidden min-[375px]:inline-flex">
                <Link href="/onboarding">Open console</Link>
              </Button>
              <SiteMenu links={LANDING_SECTIONS} />
            </>
          ) : (
            children
          )}
        </div>
      </div>
    </header>
  );
}

/** `compact` is a single line, for pages that are one form or one list. */
export function SiteFooter({ compact = false }: { compact?: boolean }) {
  const legal = "© 2026 Vestiarion contributors · MIT License";
  if (compact) {
    return (
      <footer className="border-t border-line/80 px-4 py-6 text-center font-mono text-xs text-ink-3">
        {legal} · Signed decisions on Arc testnet
      </footer>
    );
  }

  const columns = [
    { title: "Product", links: LANDING_SECTIONS },
    {
      title: "Account",
      links: [
        { href: "/login", label: "Sign in" },
        { href: "/onboarding", label: "Open console" },
      ],
    },
  ];

  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="col-span-2 lg:col-span-1">
            <Wordmark />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-ink-2">
              An autonomous treasury agent. A model proposes, code enforces the boundary, and every decision is signed into a chain anyone can verify.
            </p>
          </div>
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <Eyebrow>{column.title}</Eyebrow>
              <ul className="mt-3 space-y-1">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.href.startsWith("#") ? (
                      <a href={link.href} className="inline-flex py-1.5 text-sm text-ink-2 transition-colors duration-150 ease-standard hover:text-agent">
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="inline-flex py-1.5 text-sm text-ink-2 transition-colors duration-150 ease-standard hover:text-agent">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-line pt-6 font-mono text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between">
          <p>{legal}</p>
          <p>Hash-chained decisions · Ed25519 signed · Arc testnet</p>
        </div>
      </div>
    </footer>
  );
}
```

`src/components/vx/SiteMenu.tsx`:

```tsx
"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "@/components/ui/Sheet";

/** Matches Tailwind's `md`, where the header shows its links inline. */
const WIDE = "(min-width: 48rem)";

/**
 * The landing page's links below `md`: a sheet from the top. It closes on a
 * link, on Escape, on a click outside, and when the window grows wide enough
 * to show the links inline.
 */
export function SiteMenu({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const closeWhenWide = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", closeWhenWide);
    return () => wide.removeEventListener("change", closeWhenWide);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="secondary" size="icon" aria-label="Menu" className="md:hidden">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="top" title="Menu" hideHeader>
        <nav aria-label="Site" className="mx-auto w-full max-w-6xl px-4 pb-5 pt-14 sm:px-6">
          <ul>
            {links.map((link) => (
              <li key={link.href}>
                <SheetClose asChild>
                  <a href={link.href} className="flex h-12 items-center rounded-lg px-3 text-base font-medium text-ink transition-colors duration-150 ease-standard hover:bg-raised/70">
                    {link.label}
                  </a>
                </SheetClose>
              </li>
            ))}
          </ul>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-4">
            <Button asChild variant="secondary">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/onboarding">Open console</Link>
            </Button>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3: The landing page**

Replace `src/app/page.tsx` with:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { BrandMark } from "@/components/vx/Brand";
import { fmt } from "@/components/vx/Primitives";
import { ProvenanceBar, type ProvenanceLeg } from "@/components/vx/Provenance";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { chainModes } from "@/lib/circle";
import { screeningMode } from "@/lib/compliance";
import { withFoundingOrg } from "@/lib/dal/scope";
import { getLandingMetrics, type LandingMetrics } from "@/lib/landing";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vestiarion — Verifiable Treasury Agent on Arc",
  description: "A treasury agent that screens counterparties, pays obligations, applies code-level guardrails, and signs every decision into an auditable chain on Arc testnet.",
  openGraph: {
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "See the live console, measured Arc testnet outcomes, and signed decision ledger behind an autonomous business treasury.",
    type: "website",
    siteName: "Vestiarion",
  },
  twitter: {
    card: "summary",
    title: "Vestiarion — Verifiable Treasury Agent on Arc",
    description: "An autonomous treasury agent whose decisions, refusals, and evidence are inspectable.",
  },
};

function MetricCard({ label, value, note, href, measured }: {
  label: string;
  value: string;
  note: string;
  href: string;
  measured: boolean;
}) {
  return (
    <Card asChild interactive tone={measured ? "default" : "simulated"} className={cn("group relative overflow-hidden p-5 sm:p-6", !measured && "hatch bg-surface/70")}>
      <Link href={href}>
        <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", measured ? "bg-proof" : "bg-line-strong/50")} />
        <Eyebrow>{label}</Eyebrow>
        <p className={cn("mt-3 font-mono font-semibold tracking-[-0.025em]", measured ? "text-3xl text-ink" : "text-base leading-snug text-ink-2")}>{value}</p>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          {note} <span className="font-semibold text-agent group-hover:underline">View evidence →</span>
        </p>
      </Link>
    </Card>
  );
}

/**
 * The public showcase reads the founding organization, named explicitly: a
 * sandbox organization's demo data must never inflate its "live" figures.
 */
async function LiveMetrics() {
  const metrics = await withFoundingOrg(() => getLandingMetrics());
  const hasCycles = metrics.instrumentedCycles > 0;
  const hasTransfers = metrics.settledLiveTransfers > 0;
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Instrumented cycles" value={hasCycles ? String(metrics.instrumentedCycles) : "No cycle measured yet"} note={hasCycles ? latestCycleNote(metrics) : "Phase 7 history starts with the next permitted cycle."} href={"/onboarding"} measured={hasCycles} />
        <MetricCard label="Agent decisions" value={hasCycles ? String(metrics.instrumentedDecisions) : "No decision series yet"} note={hasCycles ? "Persisted at the decision point." : "Earlier ledger entries were not backfilled into cycle metrics."} href={"/onboarding"} measured={hasCycles} />
        <MetricCard label="Live transfers settled" value={hasTransfers ? String(metrics.settledLiveTransfers) : "No measured transfer yet"} note={hasTransfers ? "Confirmed Circle payment intents on Arc testnet." : "No confirmed post-instrumentation payment intent exists."} href={"/onboarding"} measured={hasTransfers} />
        <MetricCard label="Median chain fee" value={metrics.medianChainFeeUsd == null ? "No chain-reported fee yet" : `$${fmt(metrics.medianChainFeeUsd)}`} note={metrics.medianChainFeeUsd == null ? "Provider estimates are deliberately excluded." : `${metrics.chainFeeSampleCount} chain-reported live sample${metrics.chainFeeSampleCount === 1 ? "" : "s"}.`} href={"/onboarding"} measured={metrics.medianChainFeeUsd != null} />
        <MetricCard label="Median settlement" value={metrics.medianSettlementMs == null ? "No confirmed timing yet" : `${Math.round(metrics.medianSettlementMs)} ms`} note={metrics.medianSettlementMs == null ? "Pending transfers have no invented duration." : `${metrics.settlementSampleCount} confirmed live sample${metrics.settlementSampleCount === 1 ? "" : "s"}.`} href={"/onboarding"} measured={metrics.medianSettlementMs != null} />
        <MetricCard label="Signed ledger height" value={metrics.ledgerHeight > 0 ? String(metrics.ledgerHeight) : "Ledger is empty"} note={metrics.ledgerHeight > 0 ? "Current append-only chain length." : "No entry is styled as an achievement."} href={"/onboarding"} measured={metrics.ledgerHeight > 0} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">All figures above are server-rendered from the configured Supabase project. Transfer metrics include live Arc testnet rows only; simulated rows never enter these medians.</p>
    </div>
  );
}

function latestCycleNote(metrics: LandingMetrics): string {
  return metrics.latestInstrumentedCycleAt
    ? `Latest completed ${new Date(metrics.latestInstrumentedCycleAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC.`
    : "No completed instrumented cycle.";
}

function MetricsFallback() {
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading live measurements</p>
      <Skeleton className="h-56 rounded-2xl" />
    </div>
  );
}

const claims = [
  {
    title: "A model can recommend payment. Code can still refuse it.",
    body: "Every payable verdict crosses risk, screened-limit, evidence, and liquidity checks before the provider boundary. A blocked verdict records what the model argued and which rule overruled it.",
    href: "/onboarding",
    evidence: "See the guardrail receipt",
  },
  {
    title: "Screening changes authority, not history.",
    body: "A live OpenSanctions match or labelled bundled fallback derives the current payment limit from the business baseline. Re-screening is reversible and failed lookups retain the previous verdict.",
    href: "/onboarding",
    evidence: "Inspect tiered limits",
  },
  {
    title: "Treasury moves must beat their own cost.",
    body: "The reserve policy prices projected yield against the sweep-and-redemption round trip while protecting obligations due in 7 and 14 days. Uneconomic movement stays liquid.",
    href: "/onboarding",
    evidence: "Read the economics",
  },
  {
    title: "The audit log is a cryptographic receipt, not a feed.",
    body: "Every human, agent, and system action is Ed25519-signed, linked to the previous entry, and independently verified against the full chain on demand.",
    href: "/onboarding",
    evidence: "Verify the hash chain",
  },
] as const;

function DecisionFlowDiagram() {
  const stages = ["Compliance", "AP", "Contractors", "Treasury", "Forecast"];
  return (
    <figure className="ledger-grid mx-auto max-w-5xl rounded-2xl border border-line bg-surface p-4 shadow-surface sm:p-7" aria-labelledby="flow-title" aria-describedby="flow-desc">
      <div className="flex items-end justify-between gap-4">
        <div>
          <Eyebrow className="text-agent">01 · Observe the operating cycle</Eyebrow>
          <h3 id="flow-title" className="mt-2 text-lg font-semibold tracking-tight text-ink sm:text-xl">Five stages. One accountable book.</h3>
        </div>
        <span className="hidden rounded-full border border-line bg-surface px-3 py-1 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-ink-3 sm:block">one cycle</span>
      </div>

      <ol className="mt-5 hidden grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-2 sm:grid" aria-label="Agent cycle stages">
        {stages.map((stage, index) => (
          <li key={stage} className="contents">
            <div className="min-w-0 rounded-xl border border-line bg-ground/65 px-2 py-3 text-center">
              <span className="block font-mono text-[0.625rem] text-agent">0{index + 1}</span>
              <span className="mt-1 block truncate text-sm font-semibold text-ink">{stage}</span>
            </div>
            {index < stages.length - 1 && <span aria-hidden className="text-center font-mono text-sm text-ink-3">→</span>}
          </li>
        ))}
      </ol>
      <ol className="mt-4 grid grid-cols-6 gap-2 sm:hidden" aria-label="Agent cycle stages">
        {stages.map((stage, index) => (
          <li key={stage} className={cn("col-span-2 min-w-0 rounded-xl border border-line bg-ground/65 px-2 py-2.5 text-center", index === 3 && "col-start-2")}>
            <span className="block font-mono text-[0.5625rem] text-agent">0{index + 1}</span>
            <span className="mt-0.5 block truncate text-xs font-semibold text-ink">{stage}</span>
          </li>
        ))}
      </ol>

      <div aria-hidden className="mx-auto h-7 w-px border-l border-dashed border-line-strong" />
      <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:gap-3">
        <div className="rounded-2xl border border-agent-line bg-agent-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Eyebrow className="text-agent">02 · Reason</Eyebrow>
          <p className="mt-2 font-semibold text-agent">LLM or heuristic verdict</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">action · reasoning · confidence</p>
        </div>
        <span aria-hidden className="grid h-5 rotate-90 place-items-center font-mono text-ink-3 sm:h-auto sm:rotate-0">{`→`}</span>
        <div className="rounded-2xl border border-refused-line bg-refused-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Eyebrow className="text-refused">03 · Enforce</Eyebrow>
          <p className="mt-2 font-semibold text-refused">Code guardrail</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">may override the model</p>
        </div>
        <span aria-hidden className="grid h-5 rotate-90 place-items-center font-mono text-ink-3 sm:h-auto sm:rotate-0">{`→`}</span>
        <div className="rounded-2xl border border-proof-line bg-proof-soft px-3 py-3 text-center sm:px-4 sm:py-4">
          <Eyebrow className="text-proof">04 · Act</Eyebrow>
          <p className="mt-2 font-semibold text-proof">Execute or hold</p>
          <p className="mt-1 hidden text-xs text-ink-2 sm:block">provider boundary</p>
        </div>
      </div>

      <div aria-hidden className="mx-auto h-7 w-px border-l border-dashed border-proof-line" />
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-proof-line bg-ground/80 px-3 py-3 text-left sm:px-4">
        <div className="flex items-center gap-3">
          <BrandMark className="size-8 shrink-0 text-agent" />
          <div>
            <Eyebrow className="text-proof">05 · Sign</Eyebrow>
            <p className="mt-0.5 text-sm font-semibold text-ink">Signed hash-chain ledger</p>
          </div>
        </div>
        <p className="hidden max-w-md text-xs leading-relaxed text-ink-2 min-[430px]:block sm:text-right">Evidence under every stage—including refusals.</p>
      </div>
      <figcaption id="flow-desc" className="mt-4 text-xs leading-relaxed text-ink-3">The reasoning engine proposes; deterministic policy decides; every outcome leaves a signed receipt.</figcaption>
    </figure>
  );
}

function ProofPanel({ provenance }: { provenance: ProvenanceLeg[] }) {
  const steps = [
    ["01", "Observe", "book + screening evidence"],
    ["02", "Reason", "model or explicit heuristic"],
    ["03", "Enforce", "code-level policy boundary"],
    ["04", "Sign", "append-only audit receipt"],
  ] as const;
  return (
    <Card asChild className="relative overflow-hidden p-5 sm:p-6">
      <aside>
        <div aria-hidden className="absolute -right-14 -top-16 size-44 rounded-full bg-agent-soft blur-2xl motion-safe:animate-drift" />
        <div className="relative">
          <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <Eyebrow className="text-agent">System state</Eyebrow>
              <p className="mt-1 text-sm font-semibold text-ink">Proof before movement</p>
            </div>
            <div className="relative">
              <BrandMark className="size-11 text-agent drop-shadow-logo" />
              <span className="absolute -bottom-1 -right-1 rounded-full border border-line bg-surface px-1.5 py-0.5 font-mono text-[0.5rem] font-bold text-agent">01</span>
            </div>
          </div>
          <ol className="my-5 space-y-3">
            {steps.map(([number, title, detail]) => (
              <li key={number} className="grid grid-cols-[2rem_5rem_minmax(0,1fr)] items-baseline gap-2">
                <span className="font-mono text-[0.6875rem] font-semibold text-agent">{number}</span>
                <span className="text-sm font-semibold text-ink">{title}</span>
                <span className="text-xs text-ink-3">{detail}</span>
              </li>
            ))}
          </ol>
          <ProvenanceBar legs={provenance} />
          <div className="mt-5 rounded-xl border border-refused-line bg-refused-soft px-4 py-3">
            <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-refused">Guardrail is executable policy</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">A model verdict cannot cross the payment boundary without passing deterministic checks.</p>
          </div>
        </div>
      </aside>
    </Card>
  );
}

export default async function LandingPage() {
  // The founding organization's modes, like the metrics below; chainModes()
  // still answers when its Circle credentials cannot be read (R12).
  const modes = await withFoundingOrg(async () => chainModes());
  const currentScreeningMode = screeningMode();
  const provenance: ProvenanceLeg[] = [
    { label: "Payments", detail: "Arc testnet", live: modes.mode === "live" },
    { label: "Yield", detail: "USYC reserve", live: modes.earnMode === "live" },
    { label: "Screening", detail: currentScreeningMode === "live" ? "OpenSanctions" : "bundled list", live: currentScreeningMode === "live" },
  ];

  return (
    <div className="min-h-dvh overflow-x-clip bg-transparent">
      <SiteHeader landing />

      <main id="main">
        <section className="ledger-grid relative overflow-hidden border-b border-line bg-surface/30">
          <div aria-hidden className="absolute -left-36 top-8 size-[28rem] rounded-full bg-proof-soft/80 blur-3xl motion-safe:animate-drift" />
          <div aria-hidden className="absolute -right-28 bottom-0 size-[30rem] rounded-full bg-agent-soft/80 blur-3xl motion-safe:animate-drift" />
          <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,1fr)_27rem] lg:items-center lg:py-24">
            <div>
              <Eyebrow className="text-agent">Autonomous treasury · Arc testnet</Eyebrow>
              <h1 className="mt-5 max-w-4xl text-balance text-5xl font-semibold leading-[0.97] tracking-[-0.055em] text-ink sm:text-7xl">
                Money moves.
                <br />
                <span className="font-serif font-normal italic text-agent">Evidence remains.</span>
              </h1>
              <p className="mt-6 max-w-2xl text-pretty font-serif text-xl leading-relaxed text-ink-2 sm:text-[1.65rem]">
                Vestiarion screens counterparties, matches obligations, verifies work, and manages liquidity. A model proposes each action; code enforces the boundary; a signed ledger keeps the receipt.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href={"/onboarding"}>See the agent run</Link>
                </Button>
                <Button asChild size="lg" variant="secondary" className="bg-surface/80">
                  <Link href={"/onboarding"}>Verify the ledger</Link>
                </Button>
              </div>
            </div>
            <ProofPanel provenance={provenance} />
          </div>
        </section>

        <section id="measurements" aria-labelledby="measurements-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-10 pt-14 sm:px-6 sm:pb-14 sm:pt-20">
          <Reveal>
            <div className="mb-6 max-w-3xl">
              <Eyebrow>Live database receipts</Eyebrow>
              <h2 id="measurements-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">Numbers only appear after the system produces them.</h2>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">The current ledger can contain real earlier evidence while post-instrumentation cycle and transfer series remain empty. The page keeps that distinction visible.</p>
            </div>
            <Suspense fallback={<MetricsFallback />}>
              <LiveMetrics />
            </Suspense>
          </Reveal>
        </section>

        <section id="how-it-works" aria-labelledby="how-it-works-title" className="scroll-mt-16 border-y border-line bg-surface/55">
          <div className="mx-auto max-w-6xl px-4 pb-8 pt-12 sm:px-6 sm:pb-12 sm:pt-16">
            <Reveal>
              <Eyebrow>How a decision becomes an action</Eyebrow>
              <h2 id="how-it-works-title" className="mb-6 mt-3 max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">One loop. Two layers of judgment. One receipt chain.</h2>
              <DecisionFlowDiagram />
            </Reveal>
          </div>
        </section>

        <section id="proof" aria-labelledby="proof-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-14 pt-10 sm:px-6 sm:pb-20 sm:pt-14">
          <Reveal>
            <Eyebrow>Claims with receipts</Eyebrow>
            <h2 id="proof-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">Do not take the landing page’s word for it.</h2>
          </Reveal>
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
            {claims.map((claim, index) => (
              <Reveal key={claim.title} delay={index * 60}>
                <Card asChild interactive className="group relative block h-full overflow-hidden p-6 sm:p-7">
                  <Link href={claim.href}>
                    <span className="absolute right-5 top-4 font-mono text-4xl font-bold text-raised">0{index + 1}</span>
                    <h3 className="relative max-w-[28rem] text-xl font-semibold tracking-tight text-ink">{claim.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-ink-2">{claim.body}</p>
                    <p className="mt-4 text-sm font-medium text-agent group-hover:underline">{claim.evidence} →</p>
                  </Link>
                </Card>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="border-t border-line bg-agent text-on-agent">
          <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-on-agent">Open the evidence, not a scripted demo.</h2>
              <p className="mt-2 text-sm text-on-agent/75">Inspect the current book, every refusal, and the chain verifier.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" variant="inverse">
                <Link href={"/onboarding"}>Open console</Link>
              </Button>
              <Button asChild size="lg" variant="ghost" className="border border-on-agent/35 text-on-agent hover:bg-on-agent/10 hover:text-on-agent">
                <Link href={"/onboarding"}>Measured outcomes</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 4: The not-found pages**

`src/app/not-found.tsx`:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

/** Any address that matches no page. Workspace addresses have their own, in `o/not-found.tsx`. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md text-center">
          <p>
            <Eyebrow className="text-agent">404</Eyebrow>
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink">This page does not exist</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">The address may be mistyped, or the page may have moved.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild>
              <Link href="/onboarding">Open console</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/">Go to the homepage</Link>
            </Button>
          </div>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
```

`src/app/o/not-found.tsx`:

```tsx
import { LogOut } from "lucide-react";
import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

/**
 * `notFound()` for `/o/[slug]/*` lands here. Deliberately vague: whether the
 * slug does not exist and whether this account is simply not a member of it
 * are indistinguishable from the outside, and staying vague is what keeps a
 * workspace's existence from leaking to a stranger who guesses its slug.
 *
 * Next.js does not pass params to a not-found boundary, so this reads none.
 */
export default function OrgNotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          <p>
            <Eyebrow className="text-agent">404</Eyebrow>
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">Workspace not found</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-3">This workspace does not exist, or your account is not a member of it.</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/onboarding">Your workspaces</Link>
            </Button>
            <form action={signOut}>
              <SubmitButton variant="secondary" icon={<LogOut />} pendingLabel="Signing out…">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
```

- [ ] **Step 5: Verify, build and commit**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add src/components/vx/Brand.tsx src/components/vx/SiteChrome.tsx src/components/vx/SiteMenu.tsx src/app/page.tsx src/app/not-found.tsx src/app/o/not-found.tsx
git commit -m "feat(ui): the public pages' chrome and the landing page on the design system

Header, footer and landing page use the shared buttons and cards; the phone
menu is a sheet that closes on a link, on Escape and when the window widens;
below-the-fold sections rise into view once without hiding anything before
scripts run.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 3: Sign-in, workspaces and invitations

**Files:**
- Modify: `src/components/ui/EmptyState.tsx` (`titleAs` accepts `"h1"`), `tests/ui-display.test.tsx`
- Rewrite: `src/components/auth/LoginForm.tsx`, `src/app/login/page.tsx`, `src/components/CreateWorkspaceForm.tsx`, `src/components/AcceptInvitationForm.tsx`, `src/components/AcceptInvitationByIdForm.tsx`, `src/app/onboarding/page.tsx`, `src/app/invite/[token]/page.tsx`

**Interfaces:**
- Consumes: `Avatar`, `Button`, `Callout`, `Card`, `EmptyState`, `Field`, `FormMessage`, `Input`, `SubmitButton`, `useActionForm` (`@/components/ui/*`); `signInWithEmail`/`LoginState`, `signInWithGoogle`, `signOut` (`@/app/login/actions`); `createWorkspaceAction`/`CreateWorkspaceResult`; `acceptInvitationAction`, `acceptInvitationByIdAction`, `AcceptInvitationResult`.
- Produces: the same default exports and props as today (`LoginForm({ next })`, `CreateWorkspaceForm()`, `AcceptInvitationForm({ token })`, `AcceptInvitationByIdForm({ invitationId })`).

- [ ] **Step 1: A page-level empty state (test first)**

Add to the `EmptyState` block of `tests/ui-display.test.tsx`:

```tsx
  it("can be a page's main heading", () => {
    expect(html(<EmptyState title="This invitation has expired" titleAs="h1" />)).toContain("<h1");
  });
```

Vitest does not typecheck, so this test already passes at runtime; `npm run typecheck` is what fails (`"h1"` is not assignable). In `src/components/ui/EmptyState.tsx` change the prop type `titleAs?: "h2" | "h3";` to `titleAs?: "h1" | "h2" | "h3";`. Run `npx vitest run tests/ui-display.test.tsx` and `npm run typecheck`: both pass.

- [ ] **Step 2: The sign-in form and page**

`src/components/auth/LoginForm.tsx`:

```tsx
"use client";

import { Mail } from "lucide-react";
import { signInWithEmail, type LoginState } from "@/app/login/actions";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: LoginState = { ok: false, message: "" };

/**
 * The address stays in the field after sending, so a mistyped one is visible
 * next to the confirmation that names it.
 */
export default function LoginForm({ next }: { next: string }) {
  const { state, formProps } = useActionForm(signInWithEmail, INITIAL);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field id="email" label="Work email">
        <Input name="email" type="email" autoComplete="email" required placeholder="name@company.com" />
      </Field>
      <SubmitButton icon={<Mail />} pendingLabel="Sending…" className="w-full">
        Email me a sign-in link
      </SubmitButton>
      <FormMessage tone={state.message ? (state.ok ? "success" : "error") : "neutral"}>{state.message}</FormMessage>
    </form>
  );
}
```

`src/app/login/page.tsx`:

```tsx
import type { Metadata } from "next";
import LoginForm from "@/components/auth/LoginForm";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { loginErrorMessage } from "@/lib/auth/messages";
import { safeNext } from "@/lib/auth/routes";
import { signInWithGoogle } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
};

/** Google appears only once the operator has enabled the provider in Supabase and said so here. */
function googleSignInEnabled(): boolean {
  return process.env.AUTH_GOOGLE_ENABLED === "true";
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const next = safeNext(typeof query.next === "string" ? query.next : null);
  const error = loginErrorMessage(typeof query.error === "string" ? query.error : null);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Sign in to Vestiarion</h1>
          <p className="mt-2 text-sm text-ink-3">We email you a link. No password to remember or leak.</p>
          {error && (
            <Callout tone="refused" role="alert" className="mt-4">
              {error}
            </Callout>
          )}
          <Card className="mt-6 p-5 sm:p-6">
            <LoginForm next={next} />
            {googleSignInEnabled() && (
              <form action={signInWithGoogle} className="mt-4 border-t border-line pt-4">
                <input type="hidden" name="next" value={next} />
                <SubmitButton variant="secondary" pendingLabel="Opening Google…" className="w-full">
                  Continue with Google
                </SubmitButton>
              </form>
            )}
          </Card>
          <p className="mt-5 text-center text-xs leading-relaxed text-ink-3">No account yet? The same link creates one.</p>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
```

- [ ] **Step 3: Workspace and invitation forms**

`src/components/CreateWorkspaceForm.tsx`:

```tsx
"use client";

import { Plus } from "lucide-react";
import { createWorkspaceAction, type CreateWorkspaceResult } from "@/app/onboarding/actions";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: CreateWorkspaceResult = { ok: false, message: "" };

/** Success navigates to the new workspace, so the only message shown here is a refusal. */
export default function CreateWorkspaceForm() {
  const { state, formProps } = useActionForm(createWorkspaceAction, INITIAL);
  return (
    <Card asChild className="space-y-4 p-5 sm:p-6">
      <form {...formProps}>
        <Field id="workspace-name" label="Workspace name" description="It starts as a sandbox: the money in it is simulated.">
          <Input name="name" type="text" required maxLength={80} autoComplete="organization" />
        </Field>
        <SubmitButton icon={<Plus />} pendingLabel="Creating…" className="w-full">
          Create workspace
        </SubmitButton>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}
```

`src/components/AcceptInvitationForm.tsx`:

```tsx
"use client";

import { Check } from "lucide-react";
import { acceptInvitationAction, type AcceptInvitationResult } from "@/app/invite/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: AcceptInvitationResult = { ok: false, message: "" };

/** Success redirects into the workspace, so the only message ever shown here is a refusal. */
export default function AcceptInvitationForm({ token }: { token: string }) {
  const { state, formProps } = useActionForm(acceptInvitationAction, INITIAL);
  return (
    <Card asChild className="space-y-3 p-5 sm:p-6">
      <form {...formProps}>
        <input type="hidden" name="token" value={token} />
        <SubmitButton icon={<Check />} pendingLabel="Accepting…" className="w-full">
          Accept invitation
        </SubmitButton>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}
```

`src/components/AcceptInvitationByIdForm.tsx`:

```tsx
"use client";

import { acceptInvitationByIdAction, type AcceptInvitationResult } from "@/app/invite/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: AcceptInvitationResult = { ok: false, message: "" };

/** Success redirects into the workspace, so the only message ever shown here is a refusal. */
export default function AcceptInvitationByIdForm({ invitationId }: { invitationId: string }) {
  const { state, formProps } = useActionForm(acceptInvitationByIdAction, INITIAL);
  return (
    <form {...formProps} className="flex shrink-0 flex-col items-end gap-1">
      <input type="hidden" name="invitationId" value={invitationId} />
      <SubmitButton size="sm" pendingLabel="Accepting…">
        Accept
      </SubmitButton>
      {!state.ok && state.message && (
        <p role="alert" className="text-xs text-refused">
          {state.message}
        </p>
      )}
    </form>
  );
}
```

- [ ] **Step 4: The onboarding and invitation pages**

`src/app/onboarding/page.tsx`:

```tsx
import type { Metadata } from "next";
import { ChevronRight, LogOut } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import AcceptInvitationByIdForm from "@/components/AcceptInvitationByIdForm";
import CreateWorkspaceForm from "@/components/CreateWorkspaceForm";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { HOME_PATH } from "@/components/vx/nav";
import { membershipsOf } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";
import { pendingInvitationsFor } from "@/lib/platform/members";

export const metadata: Metadata = { title: "Workspaces" };

type OnboardingPageProps = {
  searchParams: Promise<{ new?: string | string[] }>;
};

const expiresFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Where a signed-in person lands, and where they create a workspace. Signing
 * in sends people here by default, so one workspace still goes straight in;
 * `?new`, which the workspace switcher links to, stays here to list workspaces
 * and create another. Several: choose. None: create the first.
 *
 * Also where an invitation on another device, another browser, or from
 * Google sign-in, is found again: the `vx_after_sign_in` cookie
 * (src/lib/auth/after-sign-in.ts) only covers the same browser, so any open
 * invitation for this person's address is listed here too, and finding one
 * holds off the single-workspace redirect — the person came here for a
 * reason, even with one workspace already.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const user = await verifySession("/onboarding");
  const [memberships, invitations] = await Promise.all([
    membershipsOf(user.id),
    // Best-effort: this is the default landing page after every sign-in, so a
    // failure here must not take the page down with it — the workspace list
    // below still works without it.
    pendingInvitationsFor(user.id).catch(() => {
      console.error("pending invitations unavailable");
      return [];
    }),
  ]);
  const query = await searchParams;
  if (memberships.length === 1 && query.new === undefined && invitations.length === 0) {
    redirect(orgHref(memberships[0].slug, HOME_PATH));
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        {user.email && <span className="hidden max-w-[16rem] truncate text-sm text-ink-3 sm:block">{user.email}</span>}
        <form action={signOut}>
          <SubmitButton variant="ghost" icon={<LogOut />} pendingLabel="Signing out…">
            Sign out
          </SubmitButton>
        </form>
      </SiteHeader>
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">{memberships.length ? "Choose a workspace" : "No workspace yet"}</h1>
          {invitations.length > 0 && (
            <section aria-labelledby="invitations-title" className="mt-6">
              <h2 id="invitations-title" className="text-lg font-semibold text-ink">
                Invitations for you
              </h2>
              <ul className="mt-4 space-y-2">
                {invitations.map((invitation) => (
                  <Card asChild key={invitation.invitationId} tone="agent">
                    <li className="flex items-center gap-3 px-4 py-3">
                      <Avatar name={invitation.orgName} tone="agent" shape="square" size="lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-ink">{invitation.orgName}</p>
                        <p className="text-xs text-ink-3">
                          Invited as <span className="capitalize">{invitation.role}</span> · expires {expiresFormat.format(new Date(invitation.expiresAt))}
                        </p>
                      </div>
                      <AcceptInvitationByIdForm invitationId={invitation.invitationId} />
                    </li>
                  </Card>
                ))}
              </ul>
            </section>
          )}
          {memberships.length ? (
            <>
              <p className="mt-2 text-sm text-ink-3">Pick one to open. You can switch at any time from the navigation.</p>
              <ul className="mt-6 space-y-2">
                {memberships.map((membership) => (
                  <li key={membership.orgId}>
                    <Card asChild interactive>
                      <Link href={orgHref(membership.slug, HOME_PATH)} className="group flex items-center gap-3 px-4 py-3 text-ink">
                        <Avatar name={membership.name} tone="agent" shape="square" size="lg" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{membership.name}</span>
                          <span className="block font-mono text-xs capitalize text-ink-3">
                            {membership.role} · {membership.mode}
                          </span>
                        </span>
                        <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-150 ease-standard group-hover:translate-x-0.5 group-hover:text-agent" />
                      </Link>
                    </Card>
                  </li>
                ))}
              </ul>
              <h2 id="create-workspace" className="mt-10 scroll-mt-24 text-lg font-semibold text-ink">
                Create another workspace
              </h2>
              <div className="mt-4">
                <CreateWorkspaceForm />
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm leading-relaxed text-ink-3">Create a workspace to try Vestiarion with simulated money. A teammate can also invite you to theirs.</p>
              <div id="create-workspace" className="mt-6 scroll-mt-24">
                <CreateWorkspaceForm />
              </div>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
```

`src/app/invite/[token]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { CircleCheck, Clock, Unlink } from "lucide-react";
import Link from "next/link";
import AcceptInvitationForm from "@/components/AcceptInvitationForm";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { verifySession } from "@/lib/auth/session";
import { invitationPreview } from "@/lib/platform/members";

export const metadata: Metadata = { title: "Accept invitation" };

type InvitePageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where an invitation link opens. Reading it has no side effect: the
 * invitation is only accepted once the visitor submits
 * `AcceptInvitationForm`, which posts to `src/app/invite/actions.ts`. The
 * session gate runs first, so a signed-out visitor is sent to
 * `/login?next=/invite/<token>` and lands back here once signed in.
 */
export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const user = await verifySession(`/invite/${token}`);
  const invitation = await invitationPreview(token);
  const workspaces = (
    <Button asChild variant="secondary">
      <Link href="/onboarding">Your workspaces</Link>
    </Button>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {!invitation ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This invitation link is not valid" action={workspaces} />
          ) : invitation.state === "used" ? (
            <EmptyState icon={<CircleCheck />} titleAs="h1" title="This invitation has already been accepted" action={workspaces} />
          ) : invitation.state === "expired" ? (
            <EmptyState icon={<Clock />} titleAs="h1" title="This invitation has expired" body="Ask for a new one." action={workspaces} />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
                {"You’re invited to join "}
                <strong className="font-semibold">{invitation.orgName}</strong>
                {` as ${invitation.role}.`}
              </h1>
              <div className="mt-6">
                <AcceptInvitationForm token={token} />
              </div>
              {user.email && <p className="mt-4 text-sm text-ink-3">Signed in as {user.email}.</p>}
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
```

(`tests/access-gates.test.ts` requires this page not to import `acceptInvitation` — it imports only `invitationPreview` and the form, as before.)

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/components/ui/EmptyState.tsx tests/ui-display.test.tsx src/components/auth/LoginForm.tsx src/app/login/page.tsx src/components/CreateWorkspaceForm.tsx src/components/AcceptInvitationForm.tsx src/components/AcceptInvitationByIdForm.tsx src/app/onboarding/page.tsx "src/app/invite/[token]/page.tsx"
git commit -m "feat(ui): sign-in, workspaces and invitations on the design system

The sign-in, workspace and invitation forms submit through useActionForm,
so a refused submission keeps what was typed and says why beside the form.
The workspace chooser and pending invitations are cards with avatars; an
invalid, used or expired invitation says so as an empty state.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 4: Intake forms and milestone verification

**Files:**
- Modify: `src/components/ui/Table.tsx` (`containerClassName`), `tests/ui-display.test.tsx`
- Rewrite: `src/components/intake/CounterpartyIntake.tsx`, `src/components/intake/InvoiceIntake.tsx`, `src/components/intake/InvoiceCsvImport.tsx`, `src/components/MilestoneVerification.tsx`
- Modify: `src/app/o/[slug]/invoices/page.tsx` (the intake section only)

**Interfaces:**
- Consumes: `Callout`, `Card`, `Checkbox`, `CopyButton`, `Field`, `FileInput`, `FormMessage`, `Input`, `Select*`, `SubmitButton`, `Table*`, `Tabs*`, `useActionForm` (`@/components/ui/*`); `createCounterpartyAction`, `createInvoiceAction`, `importInvoicesAction`, `IntakeActionResult`; `manualMilestoneVerificationAction`, `MilestoneActionResult`; `INVOICE_CSV_TEMPLATE`, `parseInvoiceCsv`, `InvoiceCsvRow`; `csvInvoiceInputSchema`, `firstZodMessage`.
- Produces: unchanged default exports and props; `IntakeCounterparty` still exported from `InvoiceIntake.tsx`; `Table` gains `containerClassName?: string`.

- [ ] **Step 1: A table whose frame can scroll both ways (test first)**

Add to the `Table` block of `tests/ui-display.test.tsx`:

```tsx
  it("lets its frame scroll both ways when asked, for a sticky header", () => {
    const markup = html(
      <Table containerClassName="max-h-72 overflow-auto">
        <TableBody>
          <TableRow>
            <TableCell>row</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(markup).toMatch(/^<div class="[^"]*max-h-72/);
    expect(markup).toContain("overflow-auto");
    expect(markup).not.toContain("overflow-x-auto");
  });
```

Run `npx vitest run tests/ui-display.test.tsx` — FAIL (the wrapper ignores the prop). In `src/components/ui/Table.tsx`, change `Table` to:

```tsx
/**
 * A data table that scrolls sideways inside its own frame on a narrow screen.
 * `containerClassName` styles that frame — give it a max height and
 * `overflow-auto` for a sticky header over a long list.
 */
export function Table({ className, containerClassName, ...props }: ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div className={cn("w-full overflow-x-auto", containerClassName)}>
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...props} />
    </div>
  );
}
```

Re-run: PASS.

- [ ] **Step 2: Counterparty intake**

`src/components/intake/CounterpartyIntake.tsx`:

```tsx
"use client";

import { ShieldCheck } from "lucide-react";
import { createCounterpartyAction, type IntakeActionResult } from "@/app/actions/intake";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: IntakeActionResult = { ok: false, message: "" };

/** A new counterparty is screened the moment it is saved; the toast carries the verdict. */
export default function CounterpartyIntake({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(createCounterpartyAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });

  return (
    <Card asChild className="p-4 sm:p-6">
      <form {...formProps}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="cp-name" label="Legal or trading name">
            <Input name="name" required maxLength={160} autoComplete="organization" />
          </Field>
          <Field id="cp-role" label="Role">
            <Select name="role" defaultValue="vendor">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vendor">Vendor</SelectItem>
                <SelectItem value="contractor">Contractor</SelectItem>
                <SelectItem value="client">Client</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="cp-limit" label="Payment limit (USDC)" description="May be blank for clients">
            <Input name="paymentLimit" inputMode="decimal" placeholder="5000.00" />
          </Field>
          <Field id="cp-chain" label="Chain">
            <Input name="chain" required maxLength={40} defaultValue="ARC-TESTNET" />
          </Field>
          <Field id="cp-address" label="Payment address" description="Optional until payment setup">
            <Input name="address" maxLength={200} autoComplete="off" className="font-mono" />
          </Field>
          <Field id="cp-jurisdiction" label="Jurisdiction" description="ISO code or country name">
            <Input name="jurisdiction" maxLength={80} placeholder="US" />
          </Field>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">The configured limit is preserved as the baseline; screening derives current payment authority.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
          <SubmitButton icon={<ShieldCheck />} pendingLabel="Adding and screening…" className="shrink-0">
            Add and screen
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}
```

- [ ] **Step 3: Invoice intake**

`src/components/intake/InvoiceIntake.tsx`:

```tsx
"use client";

import { Plus } from "lucide-react";
import { createInvoiceAction, type IntakeActionResult } from "@/app/actions/intake";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: IntakeActionResult = { ok: false, message: "" };

export interface IntakeCounterparty {
  id: string;
  name: string;
  role: string;
}

/** One invoice, typed in. The agent evaluates it on its next cycle. */
export default function InvoiceIntake({ counterparties, orgSlug }: { counterparties: IntakeCounterparty[]; orgSlug: string }) {
  const { state, formProps } = useActionForm(createInvoiceAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  const none = counterparties.length === 0;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="invoice-direction" label="Direction">
          <Select name="direction" defaultValue="payable">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="payable">Payable</SelectItem>
              <SelectItem value="receivable">Receivable</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="invoice-counterparty" label="Counterparty" description={none ? "Add a counterparty first — every invoice is against one." : undefined}>
          <Select name="counterpartyId" required disabled={none}>
            <SelectTrigger>
              <SelectValue placeholder="Select a counterparty" />
            </SelectTrigger>
            <SelectContent>
              {counterparties.map((counterparty) => (
                <SelectItem key={counterparty.id} value={counterparty.id}>
                  {counterparty.name} · {counterparty.role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="invoice-amount" label="Amount (USDC)">
          <Input name="amount" required inputMode="decimal" placeholder="1250.00" />
        </Field>
        <Field id="invoice-due" label="Due date">
          <Input name="dueDate" required type="date" />
        </Field>
        <Field id="invoice-memo" label="Memo" optional>
          <Input name="memo" maxLength={280} />
        </Field>
        <Field id="invoice-po" label="PO reference" optional>
          <Input name="poReference" maxLength={100} placeholder="PO-100" />
        </Field>
      </div>
      <Checkbox name="goodsReceived" label="Goods or services received" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<Plus />} disabled={none} pendingLabel="Adding…" className="shrink-0">
          Add invoice
        </SubmitButton>
      </div>
      <p className="text-xs text-ink-3">The agent will evaluate this invoice on the next cycle.</p>
    </form>
  );
}
```

- [ ] **Step 4: CSV import**

`src/components/intake/InvoiceCsvImport.tsx`:

```tsx
"use client";

import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { importInvoicesAction, type IntakeActionResult } from "@/app/actions/intake";
import { CopyButton } from "@/components/ui/CopyButton";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { useActionForm } from "@/components/ui/useActionForm";
import { INVOICE_CSV_TEMPLATE, parseInvoiceCsv, type InvoiceCsvRow } from "@/lib/invoice-csv";
import { csvInvoiceInputSchema, firstZodMessage } from "@/lib/intake-validation";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const HEADINGS = ["Direction", "Counterparty", "Amount", "Memo", "PO", "Received", "Due"];

/**
 * A CSV of invoices, previewed and checked row by row in the browser before
 * anything is sent. Nothing is imported until the preview is confirmed.
 */
export default function InvoiceCsvImport({ orgSlug }: { orgSlug: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<InvoiceCsvRow[]>([]);
  const [previewError, setPreviewError] = useState("");
  const { state, formProps } = useActionForm(importInvoicesAction, INITIAL, {
    toastOnSuccess: true,
    onSuccess: () => {
      setRows([]);
      if (inputRef.current) inputRef.current.value = "";
    },
  });
  // A new file makes the last import's error stale: it is hidden until the next import says something new.
  const [dismissed, setDismissed] = useState<IntakeActionResult | null>(null);
  const actionError = !state.ok && state !== dismissed ? state.message : "";

  async function preview(file: File | undefined) {
    setRows([]);
    setPreviewError("");
    setDismissed(state);
    if (!file) return;
    if (file.size > 1_000_000) {
      setPreviewError("CSV must be smaller than 1 MB.");
      return;
    }
    try {
      const parsedRows = parseInvoiceCsv(await file.text());
      if (parsedRows.length > 200) throw new Error("Import at most 200 invoices at a time");
      parsedRows.forEach((row, index) => {
        const validated = csvInvoiceInputSchema.safeParse(row);
        if (!validated.success) throw new Error(`Row ${index + 1}: ${firstZodMessage(validated.error)}`);
      });
      setRows(parsedRows);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "CSV could not be read.");
    }
  }

  return (
    <div className="space-y-4">
      <FileInput
        id="invoice-csv"
        accept=".csv,text/csv"
        label="Choose a CSV file, or drop one here"
        description="Up to 200 invoices and 1 MB. Nothing is uploaded until you inspect the preview and confirm."
        inputRef={inputRef}
        onFile={(file) => void preview(file)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FormMessage tone="error">{previewError || actionError}</FormMessage>
        <CopyButton value={INVOICE_CSV_TEMPLATE} variant="link">
          Copy CSV template
        </CopyButton>
      </div>

      {rows.length > 0 && (
        <form {...formProps} className="space-y-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="rowsJson" value={JSON.stringify(rows)} />
          <Table containerClassName="max-h-72 overflow-auto rounded-xl border border-line" className="min-w-[48rem] text-xs">
            <TableHeader className="sticky top-0 z-10 bg-raised">
              <TableRow>
                {HEADINGS.map((heading) => (
                  <TableHead key={heading} className="px-3 py-2">
                    {heading}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={`${row.counterparty}-${index}`}>
                  <TableCell className="px-3 py-2">{row.direction}</TableCell>
                  <TableCell className="px-3 py-2 font-medium">{row.counterparty}</TableCell>
                  <TableCell className="px-3 py-2 font-mono">{row.amount}</TableCell>
                  <TableCell className="max-w-48 truncate px-3 py-2">{row.memo || "—"}</TableCell>
                  <TableCell className="px-3 py-2 font-mono">{row.po_reference || "—"}</TableCell>
                  <TableCell className="px-3 py-2">{row.goods_received || "false"}</TableCell>
                  <TableCell className="px-3 py-2 font-mono">{row.due_date}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex justify-end">
            <SubmitButton icon={<Upload />} pendingLabel="Importing…">
              {`Confirm ${rows.length} invoice${rows.length === 1 ? "" : "s"}`}
            </SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Milestone verification**

`src/components/MilestoneVerification.tsx`:

```tsx
"use client";

import { manualMilestoneVerificationAction, type MilestoneActionResult } from "@/app/actions/milestones";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: MilestoneActionResult = { ok: false, message: "" };

/** A person's own check of a milestone, recorded with a note; the agent pays verified milestones. */
export default function MilestoneVerification({ milestoneId, verified, disabled, orgSlug }: { milestoneId: string; verified: boolean; disabled?: boolean; orgSlug: string }) {
  const { state, formProps } = useActionForm(manualMilestoneVerificationAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  const noteId = `milestone-note-${milestoneId}`;

  return (
    <form {...formProps} className="mt-2 rounded-xl border border-line bg-ground/40 p-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor={noteId} className="sr-only">
          Manual verification note
        </label>
        <Input
          id={noteId}
          name="note"
          size="sm"
          required
          minLength={3}
          maxLength={280}
          disabled={disabled}
          placeholder={verified ? "Reason for revoking verification" : "Evidence checked or approver note"}
          className="h-11 sm:h-8"
        />
        <SubmitButton name="intent" value={verified ? "revoke" : "verify"} variant="secondary" size="sm" disabled={disabled} pendingLabel="Recording…" className="h-11 shrink-0 sm:h-8">
          {verified ? "Revoke manually" : "Verify manually"}
        </SubmitButton>
      </div>
      <FormMessage tone="error" className="mt-1 text-xs">
        {state.ok ? null : state.message}
      </FormMessage>
    </form>
  );
}
```

- [ ] **Step 6: The invoices page's intake section**

In `src/app/o/[slug]/invoices/page.tsx`:

1. Add imports:

```tsx
import { FileSpreadsheet, PenLine } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
```

2. Replace the whole `{canWrite ? ( <div className="grid gap-4 xl:grid-cols-2"> … </div> ) : ( <p …>Only an owner or admin of this workspace can add or import invoices.</p> )}` expression inside the “Invoice intake” section with:

```tsx
          {canWrite ? (
            <Card className="p-4 sm:p-6">
              <Tabs defaultValue="manual">
                <TabsList aria-label="Invoice intake">
                  <TabsTrigger value="manual">
                    <PenLine aria-hidden />
                    Enter one invoice
                  </TabsTrigger>
                  <TabsTrigger value="csv">
                    <FileSpreadsheet aria-hidden />
                    Import CSV
                  </TabsTrigger>
                </TabsList>
                {/* Both stay mounted, so switching tabs never loses what was typed. */}
                <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                  <InvoiceIntake orgSlug={slug} counterparties={counterparties.map(({ id, name, role }) => ({ id, name, role }))} />
                </TabsContent>
                <TabsContent value="csv" forceMount className="data-[state=inactive]:hidden">
                  <InvoiceCsvImport orgSlug={slug} />
                </TabsContent>
              </Tabs>
            </Card>
          ) : (
            <Callout>Only an owner or admin of this workspace can add or import invoices.</Callout>
          )}
```

Leave the rest of the page (its `SectionHead`, `EmptyState` and decision sections) for Plan B2.

- [ ] **Step 7: Verify, build and commit**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add src/components/ui/Table.tsx tests/ui-display.test.tsx src/components/intake/CounterpartyIntake.tsx src/components/intake/InvoiceIntake.tsx src/components/intake/InvoiceCsvImport.tsx src/components/MilestoneVerification.tsx "src/app/o/[slug]/invoices/page.tsx"
git commit -m "feat(ui): intake forms and milestone verification on the design system

Counterparty and invoice intake use fields, selects and a checkbox that
submit through useActionForm: a refusal keeps every field, a success clears
them and toasts. The CSV import is a drop zone with a scrolling preview,
and the invoice intake's two panels are tabs that keep both forms mounted.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 5: The members panel

**Files:**
- Rewrite: `src/components/MembersPanel.tsx`

**Interfaces:**
- Consumes: `Avatar`, `Badge`, `Button`, `Card`, `ConfirmDialog`, `CopyButton`, `EmptyState`, `Field`, `FormMessage`, `Input`, `SectionHeader`, `Select*`, `SubmitButton`, `Table*`, `MOTION`, `useActionForm` (`@/components/ui/*`); `changeMemberRoleAction`, `inviteMemberAction`, `removeMemberAction`, `revokeInvitationAction`, `MemberActionResult` (`@/app/actions/members`); `canAssignRole`, `OrgRole`; `Member`, `OpenInvitation`.
- Produces: `MembersPanel({ orgSlug, members, invitations, viewerId, viewerRole, assignable })` (unchanged default export).

- [ ] **Step 1: Rewrite the panel**

`src/components/MembersPanel.tsx`:

```tsx
"use client";

import { AnimatePresence, m } from "motion/react";
import { LogOut, MailCheck, Send, UserMinus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { flushSync } from "react-dom";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  type MemberActionResult,
} from "@/app/actions/members";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { MOTION } from "@/components/ui/tokens";
import { useActionForm } from "@/components/ui/useActionForm";
import { canAssignRole, type OrgRole } from "@/lib/auth/roles";
import type { Member, OpenInvitation } from "@/lib/platform/members";

const INITIAL: MemberActionResult = { ok: false, message: "" };
const EXIT = { duration: MOTION.duration.exit, ease: MOTION.ease.exit };

const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function joined(iso: string): string {
  return dateFormat.format(new Date(iso));
}

function RowError({ state }: { state: MemberActionResult }) {
  if (state.ok || !state.message) return null;
  return (
    <p role="alert" className="text-xs text-refused">
      {state.message}
    </p>
  );
}

/**
 * A role that saves itself when changed. While the change is on its way the
 * select shows the new role; afterwards it shows the server's answer — the
 * new role once saved, the old one if the change was refused.
 */
function RoleCell({ orgSlug, member, assignable }: { orgSlug: string; member: Member; assignable: readonly OrgRole[] }) {
  const [requested, setRequested] = useState<string>(member.role);
  const { state, pending, formProps } = useActionForm(changeMemberRoleAction, INITIAL, { toastOnSuccess: true });

  return (
    <form {...formProps} className="inline-flex flex-col gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={member.userId} />
      <input type="hidden" name="role" value={requested} />
      <Select
        value={pending ? requested : member.role}
        disabled={pending}
        onValueChange={(role) => {
          // The hidden input must hold the new role before the form reads it.
          flushSync(() => setRequested(role));
          formProps.ref.current?.requestSubmit();
        }}
      >
        <SelectTrigger size="sm" aria-label={`Role of ${member.email}`} className="w-32 capitalize">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {assignable.map((role) => (
            <SelectItem key={role} value={role} className="capitalize">
              {role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RowError state={state} />
    </form>
  );
}

/** Removing someone else. The viewer's own row uses `LeaveWorkspace` instead — see the note on that component. */
function RemoveMember({ orgSlug, member }: { orgSlug: string; member: Member }) {
  const formId = `remove-${member.userId}`;
  const { state, pending, formProps } = useActionForm(removeMemberAction, INITIAL, { toastOnSuccess: true });

  return (
    <form id={formId} {...formProps} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={member.userId} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<UserMinus />} loading={pending}>
            Remove
          </Button>
        }
        title={`Remove ${member.email}?`}
        description="They lose access to this workspace at once. The removal is recorded in the audit log, and you can invite them again later."
        confirmLabel="Remove member"
      />
      <RowError state={state} />
    </form>
  );
}

type LeaveForm = ReturnType<typeof useActionForm<MemberActionResult>>;

/**
 * The viewer's own row. Self-removal does not revalidate the route (see
 * `removeMemberAction`), specifically so the form's state and its redirect
 * live in `MembersPanel` — a component that is not part of whatever
 * re-renders once membership changes — rather than in a per-row component
 * that a revalidation could unmount first.
 */
function LeaveWorkspace({ orgSlug, userId, form }: { orgSlug: string; userId: string; form: LeaveForm }) {
  const formId = "leave-workspace";
  return (
    <form id={formId} {...form.formProps} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={userId} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<LogOut />} loading={form.pending}>
            Leave
          </Button>
        }
        title="Leave this workspace?"
        description="You lose access at once. An owner or admin can invite you back."
        confirmLabel="Leave workspace"
      />
      <RowError state={form.state} />
    </form>
  );
}

function InviteForm({ orgSlug, assignable }: { orgSlug: string; assignable: readonly OrgRole[] }) {
  const { state, formProps } = useActionForm(inviteMemberAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });

  return (
    <Card asChild className="space-y-3 p-4 sm:p-5">
      <form {...formProps}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        {/* The fields share one row; the result sits below it, so the email field keeps the row's free width. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="invite-email" label="Email" className="min-w-0 flex-1">
            <Input name="email" type="email" required autoComplete="email" placeholder="name@company.com" />
          </Field>
          <Field id="invite-role" label="Role" className="sm:w-40">
            <Select name="role" defaultValue={assignable[assignable.length - 1]}>
              <SelectTrigger className="capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignable.map((role) => (
                  <SelectItem key={role} value={role} className="capitalize">
                    {role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <SubmitButton icon={<Send />} pendingLabel="Inviting…" className="shrink-0">
            Invite
          </SubmitButton>
        </div>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        {state.ok && state.link && (
          <div className="rounded-xl border border-agent-line bg-agent-soft p-3">
            <p className="text-xs font-medium text-agent">{state.message}</p>
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly value={state.link} size="sm" aria-label="Invitation link" onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
              <CopyButton value={state.link} variant="secondary">
                Copy link
              </CopyButton>
            </div>
          </div>
        )}
      </form>
    </Card>
  );
}

function InvitationRow({ orgSlug, invitation, onRevoked }: { orgSlug: string; invitation: OpenInvitation; onRevoked: () => void }) {
  const formId = `revoke-${invitation.id}`;
  const { state, pending, formProps } = useActionForm(revokeInvitationAction, INITIAL, { toastOnSuccess: true, onSuccess: onRevoked });

  return (
    <form id={formId} {...formProps} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invitationId" value={invitation.id} />
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={invitation.email} tone="agent" size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{invitation.email}</p>
          <p className="text-xs capitalize text-ink-3">
            {invitation.role} · expires {joined(invitation.expiresAt)}
          </p>
        </div>
      </div>
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<X />} loading={pending}>
            Revoke
          </Button>
        }
        title={`Revoke the invitation for ${invitation.email}?`}
        description="The link stops working at once. You can send a new invitation later."
        confirmLabel="Revoke invitation"
      />
      <div className="w-full empty:hidden">
        <RowError state={state} />
      </div>
    </form>
  );
}

function OpenInvitations({ orgSlug, invitations }: { orgSlug: string; invitations: OpenInvitation[] }) {
  const [revoked, setRevoked] = useState<string[]>([]);
  const shown = invitations.filter((invitation) => !revoked.includes(invitation.id));

  return (
    <section aria-labelledby="open-invitations-title">
      <SectionHeader id="open-invitations-title" title="Open invitations" meta={`${shown.length} pending`} />
      {shown.length === 0 ? (
        <EmptyState compact icon={<MailCheck />} title="No invitations are waiting on a reply." />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {shown.map((invitation) => (
                <m.li key={invitation.id} layout exit={{ opacity: 0, x: -12 }} transition={EXIT}>
                  <InvitationRow orgSlug={orgSlug} invitation={invitation} onRevoked={() => setRevoked((list) => [...list, invitation.id])} />
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        </Card>
      )}
    </section>
  );
}

export default function MembersPanel({
  orgSlug,
  members,
  invitations,
  viewerId,
  viewerRole,
  assignable,
}: {
  orgSlug: string;
  members: Member[];
  invitations: OpenInvitation[];
  viewerId: string;
  viewerRole: OrgRole;
  assignable: readonly OrgRole[];
}) {
  const isManager = assignable.length > 0;
  const router = useRouter();
  const leave = useActionForm(removeMemberAction, INITIAL, {
    onSuccess: (result) => {
      if (result.left) router.replace("/onboarding");
    },
  });

  return (
    <div className="space-y-8">
      <section aria-labelledby="members-title">
        <SectionHeader id="members-title" title="Members" meta={`${members.length} in this workspace`} />
        <Card className="overflow-hidden">
          <Table className="min-w-[36rem]">
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {members.map((member) => {
                  const isSelf = member.userId === viewerId;
                  const canChange = !isSelf && canAssignRole(viewerRole, member.role);
                  return (
                    <m.tr key={member.userId} exit={{ opacity: 0 }} transition={EXIT}>
                      <TableCell className="max-w-[20rem]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <Avatar name={member.email} size="sm" />
                          <span className="truncate">{member.email}</span>
                          {isSelf && (
                            <Badge size="sm" tone="agent">
                              You
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>{canChange ? <RoleCell orgSlug={orgSlug} member={member} assignable={assignable} /> : <span className="capitalize">{member.role}</span>}</TableCell>
                      <TableCell className="whitespace-nowrap text-ink-2">{joined(member.joinedAt)}</TableCell>
                      <TableCell className="text-right">
                        {isSelf ? (
                          <LeaveWorkspace orgSlug={orgSlug} userId={member.userId} form={leave} />
                        ) : canChange ? (
                          <RemoveMember orgSlug={orgSlug} member={member} />
                        ) : null}
                      </TableCell>
                    </m.tr>
                  );
                })}
              </AnimatePresence>
            </TableBody>
          </Table>
        </Card>
      </section>

      {isManager && (
        <>
          <section aria-labelledby="invite-title">
            <SectionHeader id="invite-title" title="Invite someone" meta="the link is shown once, right after sending" />
            <InviteForm orgSlug={orgSlug} assignable={assignable} />
          </section>
          <OpenInvitations orgSlug={orgSlug} invitations={invitations} />
        </>
      )}
    </div>
  );
}
```

(`useActionForm<MemberActionResult>` in the `LeaveForm` type is an instantiation expression, TypeScript 4.7+. If the linter or the compiler rejects it, declare `type LeaveForm = { state: MemberActionResult; pending: boolean; formProps: ReturnType<typeof useActionForm>["formProps"] }` instead and say so in the report.)

- [ ] **Step 2: Verify, build and commit**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add src/components/MembersPanel.tsx
git commit -m "feat(ui): the members panel on the design system

Members sit in a table with avatars; a role saves itself when changed and
shows the server's answer; removing, leaving and revoking ask first; the
one-time invitation link has a copy button; a revoked invitation fades out.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 6: Screens on `/design`

**Files:**
- Create: `src/app/design/fixtures.ts`, `src/app/design/Screens.tsx`
- Modify: `src/app/design/page.tsx`

**Interfaces:**
- Consumes: `CommandPaletteProvider`, `NavPanel`, `MobileNav`, `WorkspaceSummary` (Task 1); `CounterpartyIntake`, `InvoiceIntake`, `IntakeCounterparty`, `InvoiceCsvImport`, `MilestoneVerification` (Task 4); `MembersPanel` (Task 5); `Card`, `Callout`, `Tabs*`, `Eyebrow`.
- Produces: `/design#screens`.

- [ ] **Step 1: Fixtures**

`src/app/design/fixtures.ts`:

```ts
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
```

- [ ] **Step 2: The frame demo**

`src/app/design/Screens.tsx`:

```tsx
"use client";

import { MobileNav, NavPanel } from "@/components/vx/AppNav";
import { CommandPaletteProvider } from "@/components/vx/CommandPalette";
import { EMAIL, WORKSPACE, WORKSPACES } from "./fixtures";

const HOME = "/design#screens";

/**
 * The real workspace navigation, in frames: the sidebar panel, and — below
 * `lg` — the phone top bar with its drawer. ⌘K / Ctrl K opens this demo's
 * command palette anywhere on the page. Its links lead to a workspace that
 * does not exist; use the keyboard and the menus, not the links.
 */
export function FrameDemo() {
  return (
    <CommandPaletteProvider workspace={WORKSPACE} workspaces={WORKSPACES}>
      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="h-[44rem] overflow-hidden rounded-2xl border border-line bg-surface/80 shadow-surface">
          <NavPanel home={HOME} workspace={WORKSPACE} workspaces={WORKSPACES} email={EMAIL} layoutId="design-sidebar" />
        </div>
        <div className="max-w-sm self-start overflow-hidden rounded-2xl border border-line shadow-surface">
          <MobileNav home={HOME} workspace={WORKSPACE} workspaces={WORKSPACES} email={EMAIL} />
          <p className="bg-surface p-4 text-sm leading-relaxed text-ink-2">
            The phone top bar appears here below `lg` — narrow the window to open its drawer. Press ⌘K or Ctrl K for the command palette.
          </p>
        </div>
      </div>
    </CommandPaletteProvider>
  );
}
```

- [ ] **Step 3: Add the section to `/design`**

In `src/app/design/page.tsx`:

1. Add imports:

```tsx
import { FileSpreadsheet, PenLine } from "lucide-react";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import MembersPanel from "@/components/MembersPanel";
import MilestoneVerification from "@/components/MilestoneVerification";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { COUNTERPARTIES, DESIGN_SLUG, INVITATIONS, MEMBERS } from "./fixtures";
import { FrameDemo } from "./Screens";
```

2. Add `["screens", "Screens"]` as the last entry of `SECTIONS`.
3. After the `feedback` `<Section>` (the last one), add:

```tsx
          <Section id="screens" title="Screens" description="the real components with made-up data — nothing here is saved">
            <Callout tone="held" title="These forms reach the real server actions">
              Without a signed-in member of a real workspace every submission is refused — which is how the refusal path is checked here: the message appears beside the form and what you typed stays.
            </Callout>
            <FrameDemo />
            <CounterpartyIntake orgSlug={DESIGN_SLUG} />
            <Card className="p-4 sm:p-6">
              <Tabs defaultValue="manual">
                <TabsList aria-label="Invoice intake">
                  <TabsTrigger value="manual">
                    <PenLine aria-hidden />
                    Enter one invoice
                  </TabsTrigger>
                  <TabsTrigger value="csv">
                    <FileSpreadsheet aria-hidden />
                    Import CSV
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                  <InvoiceIntake orgSlug={DESIGN_SLUG} counterparties={COUNTERPARTIES} />
                </TabsContent>
                <TabsContent value="csv" forceMount className="data-[state=inactive]:hidden">
                  <InvoiceCsvImport orgSlug={DESIGN_SLUG} />
                </TabsContent>
              </Tabs>
            </Card>
            <Card className="p-4 sm:p-5">
              <Eyebrow>Milestone verification</Eyebrow>
              <MilestoneVerification orgSlug={DESIGN_SLUG} milestoneId="00000000-0000-4000-8000-00000000000a" verified={false} />
            </Card>
            <MembersPanel orgSlug={DESIGN_SLUG} members={MEMBERS} invitations={INVITATIONS} viewerId="design-ada" viewerRole="owner" assignable={["owner", "admin", "approver", "viewer"]} />
          </Section>
```

- [ ] **Step 4: Verify, build and commit**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add src/app/design/fixtures.ts src/app/design/Screens.tsx src/app/design/page.tsx
git commit -m "feat(ui): the workspace frame, forms and members panel on /design

The real components render there with made-up data, so navigation, the
command palette, the intake forms and the members panel can be checked in
a browser without signing in.

Co-Authored-By: <implementing model> <noreply@anthropic.com>"
```

---

### Task 7: Browser verification (run by the controller)

- [ ] **Step 1:** Copy `E:\APP2028\hackathon-project\.env.local` into the worktree (it is git-ignored; the landing page reads the founding organization's metrics and `/design`'s forms need auth configuration to refuse politely). Start `npx next dev -p 3150` from the worktree in the background and open it with `preview_start {url}`. Check `requestAnimationFrame` fires; if the pane is hidden, run the DOM-level checks and ask the partner to open the browser pane for the visual ones.
- [ ] **Step 2 (Review Focus 2):** On `/design#screens`: press Ctrl K — the palette opens; type `aud` — “Audit log” is the first match; type `payables` — “AP / AR” matches; Escape closes it and focus returns. The search button's hint reads “Ctrl K” on Windows with no hydration warning in the console.
- [ ] **Step 3:** The sidebar's workspace switcher opens with the keyboard, lists three workspaces with the current one checked, closes on Escape; the account menu opens upward and shows “Sign out” in red.
- [ ] **Step 4 (Review Focus 1):** At 375px: the top bar shows; the menu button opens the drawer from the left with focus inside; Escape closes it and focus returns to the menu button; reopen and click the dimmed page — it closes; reopen and resize to 1280px — it closes.
- [ ] **Step 5 (Review Focus 3):** Fill the counterparty form and submit — “Your session has ended. Sign in again.” (or “You are not a member of this workspace.”) appears beside the button and every field, the role select included, keeps its value. Same for the invoice form (the counterparty select must be chosen first — the browser refuses the submission otherwise), the CSV import (preview a small file, confirm) and milestone verification. Switching the intake tabs keeps what was typed.
- [ ] **Step 6 (Review Focus 4, 5):** In the members panel: change Grace's role — the select shows the new role while saving, then returns to “admin” with the refusal message; Remove opens a confirmation that ignores a click outside, Cancel closes it, Confirm closes it and the Remove button shows its spinner, then the refusal. Revoke behaves the same.
- [ ] **Step 7:** Plan A's carried checks on the same page: every overlay by keyboard (Select, DropdownMenu, Dialog, Sheet, Command), the RemoveDemo fade, the tab marker glide, the reveal cards, mobile sizes.
- [ ] **Step 8:** `/`, `/login` and a 404 at 1280px and 375px: header, landing menu sheet (closes on a link and scrolls to the section), cards, CTA band, the sign-in card. No console errors.
- [ ] **Step 9:** Stop the dev server (and its node child process).
