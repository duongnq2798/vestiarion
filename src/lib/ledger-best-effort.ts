import { withOrg } from "./dal/scope";
import { appendLedgerEntry, type LedgerEntryInput } from "./ledger";

/**
 * Appends the ledger entry for a change that has already happened. A failure
 * here (an unreadable signing key, a transient error) must not turn a done
 * change into a reported failure: a retry would then be refused, or repeat
 * it. So it is logged by action and organization id only, never an address,
 * a token or the entry's detail, and swallowed.
 *
 * By default the entry is appended in the organization scope already
 * entered. A caller that runs outside any scope (the pause switch, accepting
 * an invitation) passes `enterScope`, and the append alone runs inside
 * `withOrg(orgId)` as that person.
 */
export async function appendLedgerEntryBestEffort(
  orgId: string,
  input: LedgerEntryInput,
  options: { enterScope?: { userId: string } } = {}
): Promise<void> {
  const { enterScope } = options;
  try {
    if (enterScope) {
      await withOrg(orgId, () => appendLedgerEntry(input), { userId: enterScope.userId });
    } else {
      await appendLedgerEntry(input);
    }
  } catch {
    console.error("ledger entry not recorded", input.action, orgId);
  }
}
