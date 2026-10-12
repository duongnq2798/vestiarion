import { utcDay } from "../copy";
import type { RevisionChange } from "./revision";

/** A deal's words, shared by its page and its forms. Browser-safe and pure. */

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** One change of a version, in words. */
export function changeWords(change: RevisionChange, money: (minor: number) => string): string {
  switch (change.what) {
    case "added":
      return `Adds ${change.label}, ${money(change.amountMinor)}, invoiced ${dayWords(change.invoiceOn)}`;
    case "credit":
      return `Records a credit owed to the customer: ${change.label}, ${money(-change.amountMinor)}`;
    case "removed":
      return `Stops ${change.label}, ${money(change.amountMinor)}`;
    case "moved":
      return `Moves ${change.label} from ${dayWords(change.from)} to ${dayWords(change.to)}`;
    case "amount":
      return `Changes ${change.label} from ${money(change.fromMinor)} to ${money(change.toMinor)}`;
    case "renamed":
      return `Renames ${change.from} to ${change.label}`;
  }
}
