import { ProviderError } from "../connectors/provider";
import { graphql, IDENTIFIER, notFound, UUID, type LinearHttp } from "./http";
import { emailOf, mapAcceptancePeople, mapIssue, mapViewer, type AcceptancePeople, type IssueFacts, type LinearViewer } from "./map";
import { VIEWER_QUERY } from "./oauth";

/**
 * Linear's reads (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN4, LN6, LN9): one GraphQL query for an
 * issue whole, one for the people the payee check compares, and the viewer. Every query names the issue by a variable
 * checked here first, its UUID or its identifier (`ENG-123`), which `issue(id:)` takes alike, and a person by their
 * email, a variable too; nothing a person or Linear gave as a link is ever requested. A refused call throws
 * `ProviderError`, but an issue Linear no longer shows this connection is an answer, `gone`, not a failure.
 */

/** An issue read whole, or why Linear no longer shows it. */
export type IssueRead = { kind: "issue"; issue: IssueFacts } | { kind: "gone"; reason: "not_found" | "forbidden" };

/**
 * At most this many attachments and comments are read of an issue (LN6), fewer than Asana's 100 attachments and 300
 * comments; whether there were more is kept. The 50 deliverables kept and compared are Asana's.
 */
export const ATTACHMENTS_READ = 50;
export const COMMENTS_READ = 100;
/** The history read for who completed the issue. */
const HISTORY_READ = 50;

export const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    id identifier title url description trashed archivedAt updatedAt completedAt
    state { type name }
    team { id key }
    assignee { id name }
    attachments(first: ${ATTACHMENTS_READ}) { nodes { id url title updatedAt } pageInfo { hasNextPage } }
    comments(first: ${COMMENTS_READ}) { nodes { id body createdAt } pageInfo { hasNextPage } }
    history(first: ${HISTORY_READ}) { nodes { createdAt actor { id name } toState { type } } }
  }
}`;

/** At most this many Linear users are read for one email: Linear gives each email one account in a workspace. */
const USERS_READ = 10;

/**
 * The payee check's query (LN9), from fixed parts only: the viewer, when the member who accepts connected Linear; the
 * Linear users with the payee's notice email, anywhere in the Linear workspace, whoever is on the issue; and those with
 * the member's own email. Each email goes as a variable, declared only with its part: Linear refuses a query that
 * declares a variable it does not use.
 */
export function peopleQuery(ask: { viewer: boolean; payee: boolean; member: boolean }): string {
  const variables = [ask.payee ? "$payee: String!" : null, ask.member ? "$member: String!" : null].filter((part): part is string => part !== null);
  const users = (alias: "payee" | "member") => `  ${alias}: users(filter: { email: { eqIgnoreCase: $${alias} } }, includeDisabled: true, first: ${USERS_READ}) { nodes { id email } }`;
  return [
    `query AcceptancePeople${variables.length > 0 ? `(${variables.join(", ")})` : ""} {`,
    ...(ask.viewer ? ["  viewer { id }"] : []),
    ...(ask.payee ? [users("payee")] : []),
    ...(ask.member ? [users("member")] : []),
    "}",
  ].join(" ");
}

/** What the payee check asks of Linear: the viewer's id or not, and whose emails to look up. */
export interface PeopleAsk {
  viewer: boolean;
  payeeEmail: string | null;
  memberEmail: string | null;
}

/** An issue's UUID, or its identifier in capitals; anything else is refused before a request is made. */
export function issueVariable(value: string): string {
  const id = value.trim();
  if (UUID.test(id)) return id;
  if (IDENTIFIER.test(id.toUpperCase())) return id.toUpperCase();
  throw new ProviderError("bad_response", "Linear issue: not an id");
}

export interface LinearReader {
  viewer(accessToken: string): Promise<LinearViewer>;
  /** An issue by its UUID or its identifier. */
  issue(accessToken: string, ref: string): Promise<IssueRead>;
  /** The viewer's id, and the Linear users with the payee's and the member's emails, for the payee check alone. */
  people(accessToken: string, ask: PeopleAsk): Promise<AcceptancePeople>;
}

export function linearReader(deps: LinearHttp = {}): LinearReader {
  return {
    async viewer(accessToken) {
      return mapViewer((await graphql(accessToken, VIEWER_QUERY, {}, "viewer", deps)).data);
    },

    async issue(accessToken, ref) {
      const id = issueVariable(ref);
      let answer;
      try {
        answer = await graphql(accessToken, ISSUE_QUERY, { id }, "issue", deps);
      } catch (error) {
        // An issue in a team the connection's person was taken out of is an answer about the issue, as Asana's 403 is.
        if (error instanceof ProviderError && error.failure === "forbidden") return { kind: "gone", reason: "forbidden" };
        throw error;
      }
      if (notFound(answer.errors) || (answer.data !== null && answer.data.issue === null)) return { kind: "gone", reason: "not_found" };
      if (answer.errors.length > 0 && !answer.data?.issue) throw new ProviderError("bad_response", "Linear issue: an error answered");
      const issue = mapIssue(answer.data?.issue);
      // By its UUID, the same issue; by an identifier, the issue Linear resolves it to, one moved to another team included.
      if (UUID.test(id) && issue.id !== id) throw new ProviderError("bad_response", "Linear issue: another issue answered");
      return { kind: "issue", issue };
    },

    async people(accessToken, ask) {
      const payee = ask.payeeEmail ? emailOf(ask.payeeEmail.trim()) : null;
      const member = ask.memberEmail ? emailOf(ask.memberEmail.trim()) : null;
      const parts = { viewer: ask.viewer, payee: payee !== null, member: member !== null };
      if (!parts.viewer && !parts.payee && !parts.member) return { viewerId: null, payee: [], member: [] };
      const answer = await graphql(accessToken, peopleQuery(parts), { ...(payee ? { payee } : {}), ...(member ? { member } : {}) }, "people", deps);
      // A part not answered is a check not made: the acceptance waits, rather than going ahead unchecked.
      if (answer.errors.length > 0) throw new ProviderError("bad_response", "Linear people: an error answered");
      return mapAcceptancePeople(answer.data, { viewer: parts.viewer, payee, member });
    },
  };
}
