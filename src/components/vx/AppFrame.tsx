import type { ReactNode } from "react";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { orgHref } from "@/lib/auth/org-paths";
import { MobileNav, Sidebar } from "./AppNav";
import { CommandPaletteProvider } from "./CommandPalette";
import { FrameColumn, FrameProvider } from "./FrameContext";
import { HOME_PATH } from "./nav";
import type { WorkspaceSummary } from "./workspace";
import type { PlatformStatus } from "./workspace-status";

/**
 * The navigation around every workspace page: a fixed sidebar from `lg` up,
 * which folds to an icon rail, and below it a top bar with a drawer holding
 * the same panel. Rendered by the `/o/[slug]` layout, so it stays put while
 * pages change beneath it. The command palette (⌘K / Ctrl K) and Motion's
 * layout features live here, the only part of the app that animates layout.
 *
 * It is built only from who is signed in, which workspaces they belong to and
 * the platform's facts about this one (the payments switch, the pause) —
 * platform data the layout already holds after `requireMembership`. Anything
 * read from the organization's own tables (the agent's clock, chain modes,
 * shadow mode) belongs to the page, and its header is drawn by `ProductShell`
 * (workspace shell design S4), which takes the banners and the platform's
 * facts from here.
 */
export function AppFrame({
  workspace,
  workspaces,
  email,
  platform,
  banners,
  sidebarCollapsed,
  children,
}: {
  workspace: WorkspaceSummary;
  /** Every workspace the viewer belongs to, the current one included. */
  workspaces: WorkspaceSummary[];
  email: string | null;
  platform: PlatformStatus;
  /** What every page says above its title: Arc mainnet, payments switched off, agent paused. */
  banners: ReactNode;
  /** The sidebar preference as the request's cookie holds it, so the first paint has the right width. */
  sidebarCollapsed: boolean;
  children: ReactNode;
}) {
  const home = orgHref(workspace.slug, HOME_PATH);

  return (
    <MotionProvider>
      <FrameProvider workspace={workspace} platform={platform} banners={banners} initialSidebarCollapsed={sidebarCollapsed}>
        <CommandPaletteProvider workspace={workspace} workspaces={workspaces}>
          <FrameColumn>
            <Sidebar home={home} workspaces={workspaces} email={email} />
            <MobileNav home={home} workspace={workspace} workspaces={workspaces} email={email} />
            <main id="main" tabIndex={-1} className="outline-none">
              {children}
            </main>
          </FrameColumn>
        </CommandPaletteProvider>
      </FrameProvider>
    </MotionProvider>
  );
}
