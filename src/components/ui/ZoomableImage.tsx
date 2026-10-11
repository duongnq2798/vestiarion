"use client";

import { Maximize2 } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTrigger } from "./Dialog";

/**
 * An image that opens larger in a dialog when chosen (docs clarity C3): as wide as the dialog allows up to its own
 * pixels, and never narrower than half of them (a 2x screenshot at its 1x size), so on a phone it scrolls sideways
 * inside the dialog instead of shrinking to the screen. The thumbnail is a button named after the
 * image, Escape or the close button shuts the dialog, and focus returns to the thumbnail. The image keeps its width and
 * height attributes, so the page does not move when it loads.
 */
export function ZoomableImage({ src, alt, width, height, className }: { src: string; alt: string; width?: number; height?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Enlarge: ${alt}`}
          className="group relative block w-full cursor-zoom-in rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agent"
        >
          {/* A pre-sized PNG from public/; nothing for the image optimizer to do. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async" className={className} />
          <span
            aria-hidden
            className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-lg border border-line bg-surface/95 px-2 py-1 text-xs font-medium text-ink-2 opacity-0 shadow-control transition-opacity duration-150 ease-standard group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Maximize2 className="size-3.5" />
            Enlarge
          </span>
        </button>
      </DialogTrigger>
      <DialogContent title={alt} hideHeader className="max-h-[92dvh] w-[min(96vw,80rem)] max-w-none gap-0 p-3 sm:p-4" bodyClassName="overflow-auto">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} width={width} height={height} decoding="async" className="mx-auto block h-auto max-w-none rounded-lg border border-line" style={{ width: width ? `max(min(100%, ${width}px), ${Math.round(width / 2)}px)` : "100%" }} />
      </DialogContent>
    </Dialog>
  );
}
