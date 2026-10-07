"use client";

import { BookOpen, LayoutGrid, LogOut, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { createContext, startTransition, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { Avatar } from "@/components/ui/Avatar";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/Command";
import { DOCS_TARGET, sectionTargets, shortcutLabel, workspaceTargets } from "./command-items";
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
 * workspace list, the developer docs — or signs out; nothing in it moves money.
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
      if (event.repeat) return;
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
          <CommandGroup heading="Help">
            <CommandItem value={DOCS_TARGET.id} keywords={[DOCS_TARGET.label, ...DOCS_TARGET.keywords]} onSelect={() => go(DOCS_TARGET.href)}>
              <BookOpen aria-hidden />
              {DOCS_TARGET.label}
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Account">
            <CommandItem value="create-workspace" keywords={["Create workspace", "new", "sandbox"]} onSelect={() => go("/onboarding?create#create-workspace")}>
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
