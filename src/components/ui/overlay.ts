/**
 * The classes every floating surface shares, so a menu, a select and a dialog
 * open, close and sit above the page the same way. Radix sets `data-state` and
 * `data-side`; `tw-animate-css` turns them into motion.
 */

export const overlaySurface = "z-50 rounded-xl border border-line bg-surface text-ink shadow-overlay outline-hidden";

export const overlayMotion = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
  "data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
  "duration-200 ease-emphasized data-[state=closed]:duration-150 data-[state=closed]:ease-exit",
].join(" ");

/** The dimmed page behind a dialog or a sheet. */
export const overlayBackdrop = [
  "fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
  "duration-200 ease-emphasized data-[state=closed]:duration-150 data-[state=closed]:ease-exit",
].join(" ");

/** A panel in the middle of the screen: dialogs and confirmations. */
export const dialogPanel =
  "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface p-5 text-ink shadow-overlay outline-hidden sm:p-6";

export const dialogMotion = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "duration-200 ease-emphasized data-[state=closed]:duration-150 data-[state=closed]:ease-exit",
].join(" ");

/**
 * A row in a menu, a select or the command palette. 44px tall on touch widths. The current row (under the pointer
 * or the arrow keys) takes a tint and, like the nav's current section, an agent bar at its left edge: the tint reads
 * about 1.1:1 against the panel, the bar 6:1.
 */
export const menuItemBase =
  "relative flex min-h-11 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-2 outline-hidden transition-colors duration-150 ease-standard sm:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0 [&>svg]:text-ink-3 before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r-full before:bg-agent before:opacity-0 before:transition-opacity before:duration-150 before:ease-standard";

/** A Radix menu or select row: Radix marks the row under the pointer or the arrow keys `data-highlighted`. */
export const menuItem = `${menuItemBase} data-[highlighted]:bg-raised/70 data-[highlighted]:text-ink data-[highlighted]:before:opacity-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50`;
