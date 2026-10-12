/**
 * Where focus goes in a tab list on a key (WAI-ARIA tabs, manual activation): Left and Right move to the tab beside,
 * wrapping at the ends; Home and End go to the first and the last. Any other key leaves focus where it is (null).
 */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
