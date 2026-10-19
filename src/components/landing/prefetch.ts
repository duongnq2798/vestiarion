/**
 * Whether a link on the landing prefetches the page it opens (landing motion M4). Next prefetches each link as it
 * scrolls into view: a full scroll of the landing made 49 prefetches, 626 KB, and 570 KB of it was the docs and
 * guides, which few visitors open from here and which still load when clicked. Those are not prefetched; the call to
 * action, sign-in, /how-it-decides and the other pages still are. `undefined` leaves Next's default.
 */
export function landingPrefetch(href: string): false | undefined {
  return href.startsWith("/docs") ? false : undefined;
}
