"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { Button } from "@/components/ui/Button";
import { freeTool, freeToolCtaId, freeToolFirstTouch, type FreeTool, type FreeToolSlug } from "@/lib/free-tools";
import { firstTouchCookie, hasFirstTouch } from "@/lib/growth/attribution";

/**
 * Keeps a free tool as this browser's first touch, only when none is kept yet, so an earlier campaign keeps the credit.
 * Nothing it writes comes from the page's fields.
 */
function keepToolFirstTouch(tool: FreeTool) {
  try {
    if (hasFirstTouch(document.cookie)) return;
    document.cookie = firstTouchCookie(freeToolFirstTouch(tool, document.referrer, window.location.host, new Date()), window.location.protocol === "https:");
  } catch {
    // A browser that refuses cookies keeps no first touch; the link goes on all the same.
  }
}

/**
 * A free tool's **Try it on your bills** (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3): the
 * landing's start, with shadow mode ticked, named `<slug>-start` for the analytics click. Choosing it credits the
 * workspace this browser opens next to the tool: a click, or a middle click that opens a new tab, writes the tool's
 * first touch to the cookie `FirstTouch` writes (src/lib/growth/attribution.ts), so it survives the sign-in a
 * signed-out visitor is sent through. Never as it renders, and it sends nothing. Kept apart from the tools' checkers,
 * whose code touches no cookie.
 */
export function ToolCta({ tool }: { tool: FreeToolSlug }) {
  const entry = freeTool(tool);
  const onAuxClick = (event: MouseEvent) => {
    if (event.button === 1) keepToolFirstTouch(entry);
  };
  return (
    <Button asChild>
      <Link href={TRY_HREF} data-cta={freeToolCtaId(entry.slug)} onClick={() => keepToolFirstTouch(entry)} onAuxClick={onAuxClick}>
        {TRY_LABEL}
      </Link>
    </Button>
  );
}
