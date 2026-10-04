/**
 * Where a person's action came from, when it was not the console (integrations design R3). A domain function that
 * records a person's decision spreads it into its ledger entry's `detail`, so the signed entry names the surface and
 * the link or key it came through. The console passes none: an entry without `via` is the console's, as it always was.
 */
export type Provenance =
  | { via: "telegram" | "slack"; linkId: string }
  | { via: "api"; apiKeyId: string }
  /** A pull request comment: the installation it came through, and the GitHub user who wrote it (bounties B5). */
  | { via: "github"; installationId: number; login: string };
