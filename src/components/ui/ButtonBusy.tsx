"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useBusyIndicator } from "./busy";
import { Spinner } from "./Spinner";

/**
 * What a `Button` shows inside it (docs/superpowers/specs/2026-11-14-loading-states-design.md L1–L3). The button is
 * disabled and busy the moment its work starts, so it cannot be pressed twice; the spinner takes the leading icon's
 * place only once the work has run for a moment, and stays long enough to be seen. While it is busy the button keeps
 * at least the width it had, so a shorter label or a missing icon never makes the row around it jump.
 */
export function ButtonBusy({ loading, icon, iconOnly, children }: { loading: boolean; icon?: ReactNode; iconOnly: boolean; children?: ReactNode }) {
  const shown = useBusyIndicator(loading);
  const busy = loading || shown;
  const marker = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const button = marker.current?.parentElement;
    if (!button || !busy) return;
    button.style.minWidth = `${button.getBoundingClientRect().width}px`;
    return () => {
      button.style.minWidth = "";
    };
  }, [busy]);

  return (
    <>
      <span ref={marker} hidden />
      {shown ? <Spinner /> : icon}
      {shown && iconOnly ? null : children}
    </>
  );
}
