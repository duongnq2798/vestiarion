"use client";

import { ChevronDown, ChevronsUpDown, LogOut, Trash2 } from "lucide-react";
import { startTransition, useState, type ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { DeleteAccountDialog } from "@/components/DeleteAccountDialog";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";

/**
 * Who is signed in, and the way out: signing out, or deleting the account
 * (spec §6, A1), which needs no workspace role and so is always offered.
 * Delete account is the menu's last row, under its own separator, so the one
 * action that cannot be taken back is never the first thing the eye lands on.
 *
 * `sidebar` is the workspace frame's full-width row at the foot of the nav;
 * `header` is a compact avatar for the header of a page outside a workspace
 * (/onboarding). `children` are rows of the page's own, above Sign out.
 */
export function AccountMenu({ email, placement, children }: { email: string | null; placement: "sidebar" | "header"; children?: ReactNode }) {
  const label = email ?? "this account";
  const [deleting, setDeleting] = useState(false);
  const header = placement === "header";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {header ? (
            <Button variant="ghost" className="h-10 gap-1.5 rounded-full py-0 pl-1 pr-2 sm:h-10 data-[state=open]:bg-raised/70">
              <Avatar name={email ?? "?"} />
              <ChevronDown aria-hidden className="text-ink-3" />
              <span className="sr-only">Account: {label}</span>
            </Button>
          ) : (
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
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={header ? "bottom" : "top"}
          align={header ? "end" : "start"}
          className={header ? "w-64 max-w-[calc(100vw-2rem)]" : "w-(--radix-dropdown-menu-trigger-width) min-w-56"}
        >
          <DropdownMenuLabel className="flex items-center gap-2.5 px-2.5 py-2 font-sans text-sm font-normal normal-case tracking-normal">
            <Avatar name={email ?? "?"} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-ink-3">Signed in as</span>
              <span className="block truncate font-medium text-ink" title={email ?? undefined}>
                {label}
              </span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {children}
          <DropdownMenuItem
            onSelect={() =>
              startTransition(async () => {
                await signOut();
              })
            }
          >
            <LogOut aria-hidden />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger" onSelect={() => setDeleting(true)}>
            <Trash2 aria-hidden />
            Delete account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Outside the menu, so closing the menu does not unmount it; controlled, since a menu item is not a dialog trigger. */}
      <DeleteAccountDialog open={deleting} onOpenChange={setDeleting} />
    </>
  );
}
