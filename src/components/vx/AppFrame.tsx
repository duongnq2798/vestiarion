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
