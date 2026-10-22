/**
 * The words of "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md), shared by the payee's
 * email and page and by Counterparties. Pure: no database, safe in client components.
 */

/** How the address changed (AC2). */
export type AddressChangeVia = "member" | "payee_link" | "github";

/** What became of a check (AC5): waiting, the payee's answer, or replaced by a newer change. */
export type AddressCheckStatus = "open" | "confirmed" | "disputed" | "replaced";

/** An address shortened to its first 6 and last 4 characters, as a person compares them. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

/** "through your payment link", "by someone at Pinecrest Studio", "on GitHub, by @ana". */
export function viaWords(via: AddressChangeVia, orgName: string, githubLogin: string | null): string {
  if (via === "payee_link") return "through your payment link";
  if (via === "github") return githubLogin ? `on GitHub, by @${githubLogin}` : "on GitHub";
  return `by someone at ${orgName}`;
}

/** A day and time as the email and the page say it: "21 October 2026, 14:05 UTC". */
export function changedAtWords(iso: string): string {
  const at = new Date(iso);
  const day = at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

/**
 * What Counterparties says of a payee's latest check (AC5), or null when there is nothing to say. Its caller passes only a
 * check about the address on file.
 */
export function checkLine(input: { status: AddressCheckStatus; sentAt: string | null; frozen: boolean; expired?: boolean }): string | null {
  if (input.frozen) return "Frozen: their billing email said they did not make this change.";
  if (input.status === "confirmed") return "Their billing email said they made this change.";
  if (input.status === "disputed") return "Their billing email said they did not make this change.";
  if (input.status === "open" && input.sentAt) {
    return input.expired
      ? "Their billing email was asked whether they made this change, and did not answer."
      : "Their billing email was asked whether they made this change, and has not answered yet.";
  }
  return null;
}

/** Whether a check is about the address now on file, case ignored: only that one is shown beside it (AC5). */
export function aboutAddress(checkTo: string, onFile: string | null): boolean {
  return onFile !== null && checkTo.toLowerCase() === onFile.toLowerCase();
}
