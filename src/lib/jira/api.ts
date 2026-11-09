import { ProviderError } from "../connectors/provider";
import { apiInit, apiUrl, discard, failureOf, ISSUE_ID, ISSUE_JSON_BYTES, ISSUE_KEY, jiraFetch, jsonOf, JSON_BYTES, type JiraHttp } from "./http";
import { COMMENTS_READ, commentsTruncated, emailOf, mapIssue, mapMyself, mapPeople, mapUpdated, type IssueFacts, type JiraSite } from "./map";
import { accessibleSites } from "./oauth";

/**
 * Jira's reads (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR8, JR12, JR16): an issue at one of two
 * depths, the change check over many issues, the people the payee check compares, and the sites a token reaches. Every
 * address is built by `apiUrl` from parts checked here first, the site's cloudId and the issue's numeric id or key;
 * nothing a person or Jira gave as a link is ever requested, and no person field of an issue is ever asked for (JR19).
 * A refused call throws `ProviderError`, but an issue Jira no longer shows this connection is an answer, `gone`, not a
 * failure: Jira answers 404 for an issue that is not there and for one the person may not see alike.
 */

/** An issue read, or why Jira no longer shows it. */
export type IssueRead = { kind: "issue"; issue: IssueFacts } | { kind: "gone"; reason: "not_found" | "forbidden" };

/** A status read's fields (JR8): enough to know whether the issue is done, and when, in one request. */
export const ISSUE_STATUS_FIELDS = "summary,status,resolution,resolutiondate,statuscategorychangedate,updated,project";
/** A full read's: the status read's, and what the deliverables are read from. */
export const ISSUE_FULL_FIELDS = `${ISSUE_STATUS_FIELDS},description,attachment,comment`;

/**
 * At most this many of an issue's files, of its web links and of its newest comments are read (JR8), set in `./map`,
 * where an answer is read; whether there were more is kept. The 50 deliverables kept and compared are Asana's.
 */
export { ATTACHMENTS_READ, COMMENTS_READ, REMOTE_LINKS_READ } from "./map";

/** At most this many issues are asked about in one change check, and this many checks are made in one call (JR16). */
export const CHANGED_PER_CALL = 50;
export const CHANGED_CALLS = 2;
/** At most this many Atlassian accounts are read for one email. */
const USERS_READ = 10;

export type IssueDepth = "status" | "full";
/** The site a read is on: its cloudId, which the address names, and its own address, which links are compared with. */
export type SiteRef = Pick<JiraSite, "cloudId" | "url">;

/** What the payee check asks of Jira (JR12): the connection's own account or not, and whose emails to look up. */
export interface PeopleAsk {
  myself: boolean;
  payeeEmail: string | null;
  memberEmail: string | null;
}

/** The accounts the payee check compares, in memory only: never kept (JR19). */
export interface AcceptancePeople {
  /** Null when it was not asked. */
  myselfId: string | null;
  payee: string[];
  member: string[];
}

/** An issue's numeric id, or its key in capitals; anything else is refused before an address is built. */
export function issuePathOf(ref: string): string {
  const value = ref.trim();
  if (ISSUE_ID.test(value)) return value;
  if (ISSUE_KEY.test(value.toUpperCase())) return value.toUpperCase();
  throw new ProviderError("bad_response", "Jira issue: not an id or a key");
}

export interface JiraReader {
  /** An issue by its numeric id, or by its key when it is linked. */
  issue(accessToken: string, site: SiteRef, ref: string, depth: IssueDepth): Promise<IssueRead>;
  /**
   * When each of these issues last changed, by one search per 50 (JR16): an issue left out was not answered for.
   * `refused` when Jira refused the search, as it does when an id was deleted or is hidden.
   */
  changed(accessToken: string, site: SiteRef, ids: readonly string[]): Promise<Map<string, string> | "refused">;
  /** The connection's own account, and the accounts with the payee's and the member's emails, for the payee check alone. */
  people(accessToken: string, site: SiteRef, ask: PeopleAsk): Promise<AcceptancePeople>;
  /** The Jira sites the token reaches now. */
  sites(accessToken: string): Promise<JiraSite[]>;
}

/** An issue Jira no longer shows this connection, answered by one of an issue read's requests. */
class Gone {
  constructor(readonly reason: "not_found" | "forbidden") {}
}

export function jiraReader(deps: JiraHttp = {}): JiraReader {
  const now = deps.now ?? Date.now;

  /** A GET whose answer is read as JSON; with `gone`, a 404 or a 403 is answered as `Gone`. */
  async function get(url: string, accessToken: string, label: string, maxBytes: number, gone = false): Promise<unknown> {
    const response = await jiraFetch(url, apiInit(accessToken), label, deps);
    if (gone && (response.status === 404 || response.status === 403)) {
      await discard(response);
      return new Gone(response.status === 404 ? "not_found" : "forbidden");
    }
    if (!response.ok) {
      await discard(response);
      throw failureOf(response, label, now());
    }
    return jsonOf(response, label, maxBytes);
  }

  async function search(accessToken: string, site: SiteRef, email: string): Promise<string[]> {
    const url = apiUrl(site.cloudId, "/user/search", { query: email, maxResults: String(USERS_READ) });
    return mapPeople(await get(url, accessToken, "user search", JSON_BYTES), email);
  }

  return {
    async issue(accessToken, site, ref, depth) {
      const path = issuePathOf(ref);
      const url = apiUrl(site.cloudId, `/issue/${path}`, { fields: depth === "full" ? ISSUE_FULL_FIELDS : ISSUE_STATUS_FIELDS });
      const json = await get(url, accessToken, "issue", ISSUE_JSON_BYTES, true);
      if (json instanceof Gone) return { kind: "gone", reason: json.reason };
      const answered = typeof json === "object" && json !== null ? (json as { id?: unknown }).id : undefined;
      if (typeof answered !== "string" || !ISSUE_ID.test(answered)) throw new ProviderError("bad_response", "Jira issue: no id");
      // By its id, the same issue; by a key, the issue Jira resolves it to, one moved to another project included.
      if (ISSUE_ID.test(path) && answered !== path) throw new ProviderError("bad_response", "Jira issue: another issue answered");
      if (depth === "status") return { kind: "issue", issue: mapIssue(json, null, site.url) };
      const remote = await get(apiUrl(site.cloudId, `/issue/${answered}/remotelink`), accessToken, "remote links", ISSUE_JSON_BYTES, true);
      if (remote instanceof Gone) return { kind: "gone", reason: remote.reason };
      let page: unknown = null;
      // The comments embedded in the issue were cut short: its newest 50 are read on their own.
      if (commentsTruncated(json)) {
        page = await get(apiUrl(site.cloudId, `/issue/${answered}/comment`, { orderBy: "-created", maxResults: String(COMMENTS_READ) }), accessToken, "comments", ISSUE_JSON_BYTES, true);
        if (page instanceof Gone) return { kind: "gone", reason: page.reason };
      }
      return { kind: "issue", issue: mapIssue(json, remote, site.url, page) };
    },

    async changed(accessToken, site, ids) {
      const asked = [...new Set(ids.map((id) => id.trim()))];
      if (asked.some((id) => !ISSUE_ID.test(id))) throw new ProviderError("bad_response", "Jira search: not an issue id");
      const updated = new Map<string, string>();
      for (let call = 0; call < CHANGED_CALLS; call += 1) {
        const chunk = asked.slice(call * CHANGED_PER_CALL, (call + 1) * CHANGED_PER_CALL);
        if (chunk.length === 0) break;
        const url = apiUrl(site.cloudId, "/search/jql", { jql: `id in (${chunk.join(", ")})`, fields: "updated", maxResults: String(CHANGED_PER_CALL) });
        const response = await jiraFetch(url, apiInit(accessToken), "search", deps);
        // Jira refuses the whole search when one id was deleted or cannot be seen: the caller reads them one by one.
        if (response.status === 400) {
          await discard(response);
          return "refused";
        }
        if (!response.ok) {
          await discard(response);
          throw failureOf(response, "search", now());
        }
        for (const [id, at] of mapUpdated(await jsonOf(response, "search", JSON_BYTES), new Set(chunk))) updated.set(id, at);
      }
      return updated;
    },

    async people(accessToken, site, ask) {
      const payee = emailOf(ask.payeeEmail);
      // Without the payee's email there is nothing to compare with: Jira is not asked (JR12).
      if (!payee) return { myselfId: null, payee: [], member: [] };
      const member = emailOf(ask.memberEmail);
      const myselfId = ask.myself ? mapMyself(await get(apiUrl(site.cloudId, "/myself"), accessToken, "myself", JSON_BYTES)) : null;
      return { myselfId, payee: await search(accessToken, site, payee), member: member ? await search(accessToken, site, member) : [] };
    },

    sites: (accessToken) => accessibleSites(accessToken, deps),
  };
}
