/**
 * The heading of Approvals' waiting list, for screen readers: the cards (h3) and the empty state sit right under the
 * page's h1 when the agent suggests nothing, so the list needs an h2 of its own. The page and its guide shots use it.
 */
export function WaitingHeading() {
  return <h2 className="sr-only">Waiting for a decision</h2>;
}
