import { useLayoutEffect, useState } from "react";

/**
 * The landing's tab marker glides from the tab chosen before to the one chosen now (landing motion M4). The shared
 * `Tabs` glide through Motion's layout animation, which needs `MotionProvider` and its layout features: about 31 KB
 * more script (brotli) than the landing ships today, measured, for one marker. So the landing keeps the marker the
 * chosen tab draws, as the server draws it, and only tells it where the last one stood (`--glide-*`, the old tab's
 * edges from the new one's); a CSS animation (`[data-glide]` in landing-hero.css) brings it across. Under reduced
 * motion the animation is cut and the marker moves at once.
 *
 * Pass `root` to `Tabs` as its `ref`, and `onValueChange` as its own.
 */
export function useTabGlide() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // Where the marker stood when another tab was chosen, kept until the chosen tab has drawn its own.
  const [change, setChange] = useState<{ from: DOMRect } | null>(null);

  useLayoutEffect(() => {
    const marker = root?.querySelector<HTMLElement>("[data-tab-indicator]");
    if (!change || !marker) return;
    const before = change.from;
    const after = marker.getBoundingClientRect();
    marker.style.setProperty("--glide-top", `${before.top - after.top}px`);
    marker.style.setProperty("--glide-right", `${after.right - before.right}px`);
    marker.style.setProperty("--glide-bottom", `${after.bottom - before.bottom}px`);
    marker.style.setProperty("--glide-left", `${before.left - after.left}px`);
    marker.dataset.glide = "";
  }, [change, root]);

  return {
    root: setRoot,
    onValueChange: () => {
      const from = root?.querySelector("[data-tab-indicator]")?.getBoundingClientRect();
      if (from) setChange({ from });
    },
  };
}
