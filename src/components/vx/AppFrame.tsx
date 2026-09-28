import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { orgHref } from "@/lib/auth/org-paths";
import { MobileNav, SectionNav, WorkspaceSwitcher, type WorkspaceSummary } from "./AppNav";
import { BrandMark } from "./Brand";
import { SignOutGlyph } from "./Glyphs";
import { HOME_PATH } from "./nav";

/**
 * The navigation around every workspace page: a fixed sidebar from `lg` up,
 * and below it a top bar with a drawer holding the same panel. Rendered by
 * the `/o/[slug]` layout, so it stays put while pages change beneath it.
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
  const panel = <NavPanel home={home} workspace={workspace} workspaces={workspaces} email={email} />;

  return (
    <div className="min-h-dvh lg:pl-64">
      <div className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line/80 bg-surface/80 backdrop-blur-xl lg:block">
        {panel}
      </div>
      <MobileNav home={home} workspaceName={workspace.name}>
        {panel}
      </MobileNav>
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
    </div>
  );
}

function NavPanel({
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link href={home} className="group inline-flex items-center gap-2.5 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink hover:text-agent">
          <BrandMark className="logo-shadow size-8 shrink-0 text-agent transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105" />
          <span>Vestiarion</span>
        </Link>
      </div>
      <div className="shrink-0 px-3 pb-4">
        <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
      </div>
      <SectionNav orgSlug={workspace.slug} />
      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-center gap-3 px-2 py-1.5">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold uppercase text-ground">
            {email?.charAt(0) || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-3">Signed in as</p>
            <p className="truncate text-sm font-medium text-ink" title={email ?? undefined}>
              {email ?? "this account"}
            </p>
          </div>
        </div>
        <form action={signOut} className="mt-1">
          <button
            type="submit"
            className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-ink-2 transition-colors hover:bg-raised/70 hover:text-ink lg:h-10"
          >
            <SignOutGlyph className="size-[1.125rem]" />
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
