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
            The phone top bar appears here below <code className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs">lg</code> — narrow the window to open its drawer. Press ⌘K or Ctrl K for the command palette.
          </p>
        </div>
      </div>
    </CommandPaletteProvider>
  );
}
