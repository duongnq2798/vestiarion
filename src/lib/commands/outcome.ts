/**
 * What a command did, in the words the console shows (integrations design R6). A surface shows `message`, or says
 * `code` in its own words. `changed` marks a refusal after which something did change, so a surface still refreshes
 * what it shows: an approval whose transfer failed leaves the invoice held with the reason.
 */
export interface Refused {
  ok: false;
  /** `forbidden` (the role), `surface` (where it was asked from), the domain's own code, or `failed`. */
  code: string;
  message: string;
  changed?: true;
}

export type Done<T extends object = object> = { ok: true; message: string } & T;

export type CommandOutcome<T extends object = object> = Done<T> | Refused;

export function done<T extends object = object>(message: string, data?: T): Done<T> {
  return { ok: true, message, ...data } as Done<T>;
}

export function refused(code: string, message: string, options: { changed?: true } = {}): Refused {
  return { ok: false, code, message, ...options };
}

/** The words for a failure no one can act on; the error itself goes to the server log. */
export const TRY_AGAIN = "That did not work. Try again in a moment.";
