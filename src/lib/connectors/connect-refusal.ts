/**
 * A provider's refusal to connect what it was granted, in one outcome code its Settings card says in words
 * (`?<provider>=<outcome>`): Pipedrive's `scopes`, a grant without the scopes the connector reads with
 * (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4); Jira's `no_site`, an Atlassian grant that reaches
 * no Jira site Vestiarion can read (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2). Thrown by
 * `organisations`; the callback answers with the outcome and keeps nothing. Pure.
 */
export class ConnectRefusal extends Error {
  constructor(readonly outcome: "scopes" | "no_site") {
    super(`connect refused: ${outcome}`);
    this.name = "ConnectRefusal";
  }
}
