"use client";

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { Button } from "@/components/ui/Button";
import { freeTool, freeToolCtaId, freeToolFirstTouch, toolReferrer, type FreeTool, type FreeToolSlug } from "@/lib/free-tools";
import { firstTouchCookie, hasFirstTouch } from "@/lib/growth/attribution";

/** The address this tab first loaded, from the browser's navigation entry, which a move through the router keeps. */
function firstPage(): string | undefined {
  return performance.getEntriesByType("navigation")[0]?.name;
}

/**
 * Keeps a free tool as this browser's first touch, only when none is kept yet, so an earlier campaign keeps the credit.
 * Nothing it writes comes from the page's fields.
 */
function keepToolFirstTouch(tool: FreeTool) {
  try {
    if (hasFirstTouch(document.cookie)) return;
    const referrer = toolReferrer(tool, document.referrer, firstPage());
    document.cookie = firstTouchCookie(freeToolFirstTouch(tool, referrer, window.location.host, new Date()), window.location.protocol === "https:");
  } catch {
    // A browser that refuses cookies keeps no first touch; the link goes on all the same.
  }
}

/**
 * A link to the landing's start, with shadow mode ticked, that credits the workspace this browser opens next to a free
 * tool (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3): a click, or a middle click that opens a
 * new tab, writes the tool's first touch to the cookie `FirstTouch` writes (src/lib/growth/attribution.ts), so it
 * survives the sign-in a signed-out visitor is sent through. Never as it renders, and it sends nothing. Every start on a
 * tool's page is one: its **Try it on your bills** (`ToolCta`) and the full footer's **Get started** (`SiteFooter`'s
 * `tool`, TA5). Its other props go to the link.
 */
export function ToolStartLink({ tool, ...props }: { tool: FreeToolSlug } & Omit<ComponentProps<typeof Link>, "href" | "onClick" | "onAuxClick">) {
  const entry = freeTool(tool);
  const onAuxClick = (event: MouseEvent) => {
    if (event.button === 1) keepToolFirstTouch(entry);
  };
  return <Link {...props} href={TRY_HREF} onClick={() => keepToolFirstTouch(entry)} onAuxClick={onAuxClick} />;
}

/**
 * A free tool's **Try it on your bills** (TA3): the primary button, a `ToolStartLink` named `<slug>-start` for the
 * analytics click. Kept apart from the tools' checkers, whose code touches no cookie.
 */
export function ToolCta({ tool }: { tool: FreeToolSlug }) {
  return (
    <Button asChild>
      <ToolStartLink tool={tool} data-cta={freeToolCtaId(tool)}>
        {TRY_LABEL}
      </ToolStartLink>
    </Button>
  );
}
