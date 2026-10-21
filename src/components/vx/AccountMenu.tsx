"use client";

import { ChevronDown, ChevronsUpDown, LogOut, UserCog } from "lucide-react";
import Link from "next/link";
import { startTransition, type ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";

/**
 * Who is signed in, the account's own page, and the way out. It holds no
 * danger row: deleting the account is at the end of Settings and of /account,
 * never one slip below Sign out
 * (docs/superpowers/specs/2026-10-21-delete-account-in-settings-design.md DA1).
 *
 * `sidebar` is the workspace frame's full-width row at the foot of the nav;
 * `rail` is the same, folded to the avatar on the collapsed sidebar, its menu
 * opening to the right; `header` is a compact avatar for the header of a page
 * outside a workspace (/onboarding). `children` are rows of the page's own,
 * above Sign out.
 */
export function AccountMenu({
  email,
  placement,
  railTip = false,
  children,
}: {
  email: string | null;
  placement: "sidebar" | "rail" | "header";
  /** On the folded sidebar the avatar names the account in a tooltip; one element either way, so focus stays. */
  railTip?: boolean;
  children?: ReactNode;
}) {
  const label = email ?? "this account";
  const header = placement === "header";
  const rail = placement === "rail";
  return (
    <DropdownMenu>
      <Tooltip content={label} side="right" disabled={!railTip}>
        <DropdownMenuTrigger asChild>
          {rail ? (
            <Button variant="ghost" size="icon" aria-label={`Account: ${label}`} className="rounded-full sm:size-10 aria-expanded:bg-raised/70">
              <Avatar name={email ?? "?"} />
            </Button>
          ) : header ? (
            <Button variant="ghost" className="h-10 gap-1.5 rounded-full py-0 pl-1 pr-2 sm:h-10 aria-expanded:bg-raised/70">
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
      </Tooltip>
      <DropdownMenuContent
        side={header ? "bottom" : rail ? "right" : "top"}
        align={header ? "end" : rail ? "end" : "start"}
        className={header || rail ? "w-64 max-w-[calc(100vw-2rem)]" : "w-(--radix-dropdown-menu-trigger-width) min-w-56"}
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
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserCog aria-hidden />
            Account settings
          </Link>
        </DropdownMenuItem>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
