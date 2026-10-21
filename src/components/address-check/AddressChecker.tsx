"use client";

import { CircleCheck, CircleMinus, OctagonX } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import {
  chanceWords,
  checkAddress,
  readKnownAddresses,
  sharedWords,
  type AddressCheck,
  type AddressMatch,
  type SanctionedEntry,
  type SpecialAddress,
} from "@/lib/address-check";

/**
 * The address lookalike checker (docs/superpowers/specs/2026-10-21-address-checker-design.md AC6): two fields and what
 * the rules say, as someone types. There is no form to submit, so nothing typed can reach an address bar or a server.
 */

/** Made up for the example: the second has the first's first 4 and last 4 digits, as a poisoned address would. */
export const EXAMPLE_KNOWN = "Northwind Design, 0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d\nHarbor Print Co, 0x3f9e0b6a14c27d85e9a0b3c6d1f48e27a5c9b742";
export const EXAMPLE_PAY = "0x7a2d8f06c3e1b9a457d02c6e8f1b3a9d4e7ce10d";

const ICON = "mt-0.5 size-4 shrink-0";
/** 16 px on a phone, so the browser does not zoom into the field; smaller beside a keyboard and mouse. */
const MONO_FIELD = "font-mono text-base sm:text-[0.8125rem]";

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-sm leading-relaxed text-ink-2">
      {ok === true ? (
        <CircleCheck aria-label="Passed" className={`${ICON} text-proof`} />
      ) : ok === false ? (
        <OctagonX aria-label="Failed" className={`${ICON} text-refused`} />
      ) : (
        <CircleMinus aria-label="Not checked" className={`${ICON} text-ink-3`} />
      )}
      <span>{children}</span>
    </li>
  );
}

/** One address, its shared ends underlined, and each middle digit that differs from the other's bold on a tint. */
function Marked({ address, other, leading, trailing }: { address: string; other: string; leading: number; trailing: number }) {
  const digits = address.slice(2);
  const end = digits.length - trailing;
  return (
    // Small enough on a 375 px phone that all 42 characters stay on one line, the ends side by side.
    <span className="break-all font-mono text-[0.6875rem] leading-6 text-ink-3 sm:text-[0.8125rem]">
      0x
      <span className="font-semibold text-ink underline decoration-agent decoration-2 underline-offset-4">{digits.slice(0, leading)}</span>
      {[...digits.slice(leading, end)].map((digit, index) => (
        <span key={index} className={digit === other.slice(2)[leading + index] ? undefined : "rounded-md bg-refused-soft font-semibold text-refused"}>
          {digit}
        </span>
      ))}
      <span className="font-semibold text-ink underline decoration-agent decoration-2 underline-offset-4">{digits.slice(end)}</span>
    </span>
  );
}

function Comparison({ address, match }: { address: string; match: AddressMatch }) {
  const { known } = match;
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-line bg-surface px-3.5 py-3">
      <p className="text-sm text-ink-2">
        Shares {sharedWords(match)} with {known.label}&apos;s address, and differs in between. A random address does that about once in{" "}
        {chanceWords(match.leading + match.trailing)}.
      </p>
      <div>
        <p className="text-xs font-medium text-ink-3">The address you are about to pay</p>
        <Marked address={address} other={known.address} leading={match.leading} trailing={match.trailing} />
      </div>
      <div>
        <p className="text-xs font-medium text-ink-3">{known.label}</p>
        <Marked address={known.address} other={address} leading={match.leading} trailing={match.trailing} />
      </div>
    </div>
  );
}

function specialWords(special: SpecialAddress): string {
  if (special.kind === "zero") return "This is the zero address: anything sent to it is lost.";
  if (special.kind === "burn") return "This is a burn address: anything sent to it is lost.";
  if (special.kind === "system") return "This is Arc's USDC system address, not a wallet.";
  return `This is the ${special.label} token contract, not a wallet. USDC sent to it is lost.`;
}

/** The headline once the input is an address: what to do, and the one reason that matters most. */
function Verdict({ check }: { check: AddressCheck }) {
  const alike = check.matches.find((match) => match.kind === "alike");
  const same = check.matches.find((match) => match.kind === "same");
  if (check.verdict === "stop") {
    const title = check.sanctioned
      ? "Do not pay: this address is on OFAC's sanctions list"
      : check.special
        ? "Do not pay: this is not a wallet"
        : check.checksum === "invalid"
          ? "Do not pay: its checksum does not match"
          : `Do not pay: this address is made to look like ${alike!.known.label}'s`;
    const body = check.sanctioned
      ? `OFAC lists it under ${check.sanctioned.name}.`
      : check.special
        ? specialWords(check.special)
        : check.checksum === "invalid"
          ? "Its mix of capitals does not match its EIP-55 checksum, so a character was mistyped or changed. Ask the payee for it again."
          : "This is how address poisoning works: someone makes an address with the same ends as one you pay, and gets it into your history. Ask the payee for the address again, on a call or to a contact you already had.";
    return (
      <Callout tone="refused" title={title}>
        {body}
      </Callout>
    );
  }
  if (check.verdict === "conflict") {
    return (
      <Callout tone="held" title={`It matches ${same!.known.label}, but your list has an address made to look like it`}>
        {alike!.known.label}&apos;s address shares {sharedWords(alike!)} with it. One of the two is not the payee&apos;s: confirm the address with
        the payee, on a call or to a contact you already had, before you pay.
      </Callout>
    );
  }
  if (check.verdict === "same") {
    return (
      <Callout tone="proof" title={`It is the address you know as ${same!.known.label}`}>
        Every character matches: it is the same wallet as in your list.
      </Callout>
    );
  }
  return (
    <Callout title="Nothing here says it is wrong">
      Nothing here says whose it is either. Before a first payment to it, confirm it with the payee on a call, or by a message to a contact you
      already had.
    </Callout>
  );
}

function lookalikeLine(check: AddressCheck, knownCount: number): { ok: boolean | null; text: string } {
  if (knownCount === 0) return { ok: null, text: "Add the addresses you know to compare it with them." };
  const alike = check.matches.filter((match) => match.kind === "alike");
  if (alike.length > 0) return { ok: false, text: `It is made to look like ${alike.length === 1 ? "one" : alike.length} of the ${knownCount} you know.` };
  const partial = check.matches.find((match) => match.kind === "partial");
  if (partial) return { ok: null, text: `It shares ${sharedWords(partial)} with ${partial.known.label}'s address. Compare the whole address.` };
  return { ok: true, text: `It is not made to look like any of the ${knownCount} you know.` };
}

export function AddressChecker({ sanctioned, listDate }: { sanctioned: readonly SanctionedEntry[]; listDate: string }) {
  const id = useId();
  const [pay, setPay] = useState("");
  const [knownText, setKnownText] = useState("");
  const read = useMemo(() => readKnownAddresses(knownText), [knownText]);
  const check = useMemo(() => (pay.trim() === "" ? null : checkAddress(pay, read.known, sanctioned)), [pay, read.known, sanctioned]);
  const lookalike = check?.address ? lookalikeLine(check, read.known.length) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <Field id={`${id}-pay`} label="Address you are about to pay">
          <Input
            value={pay}
            onChange={(event) => setPay(event.target.value)}
            placeholder="0x…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={MONO_FIELD}
          />
        </Field>
        <Field
          id={`${id}-known`}
          optional
          label="Addresses you know"
          description="One a line, with a name if you like. Copy them from your own records or past invoices, not from your wallet's recent activity, where a poisoned address hides."
        >
          <Textarea
            value={knownText}
            onChange={(event) => setKnownText(event.target.value)}
            placeholder={"Northwind Design, 0x…"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={MONO_FIELD}
          />
        </Field>
        {(read.known.length > 0 || read.unread.length > 0) && (
          <div className="space-y-1.5 text-sm text-ink-2">
            {read.known.length > 0 && (
              <p>
                Read {read.known.length === 1 ? "1 address" : `${read.known.length} addresses`}:{" "}
                {read.known
                  .slice(0, 8)
                  .map((entry) => `${entry.label} (${short(entry.address)})`)
                  .join(", ")}
                {read.known.length > 8 ? `, and ${read.known.length - 8} more` : ""}.{read.more ? " Only the first 200 are read." : ""}
              </p>
            )}
            {read.unread.map((line) => (
              <p key={line.line} className="flex gap-2">
                <OctagonX aria-hidden className={`${ICON} text-refused`} />
                <span>
                  Line {line.line} was not read. {line.message}
                </span>
              </p>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setKnownText(EXAMPLE_KNOWN);
              setPay(EXAMPLE_PAY);
            }}
          >
            Try an example
          </Button>
          {(pay !== "" || knownText !== "") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setKnownText("");
                setPay("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <section aria-label="What the check found" className="space-y-4">
        {/* While it is not an address yet, what is wrong changes at each keystroke, so it is shown but not announced. */}
        {check && !check.format.ok && (
          <Callout tone="held" title="Not an address yet">
            {check.format.message}
          </Callout>
        )}
        {/* Only the headline is announced as it changes, not every line under it. */}
        <div aria-live="polite">{check?.address && <Verdict check={check} />}</div>
        {check?.address && lookalike && (
          <ul className="space-y-2">
            <Check ok={true}>It is 0x and 40 hex digits, the form of an address on Arc, Base, Ethereum and every EVM chain.</Check>
            <Check ok={check.checksum === "none" ? null : check.checksum === "valid"}>
              {check.checksum === "valid"
                ? "Its mix of capitals matches its checksum (EIP-55)."
                : check.checksum === "invalid"
                  ? `Its mix of capitals does not match its checksum (EIP-55), which is ${check.checksummed}.`
                  : "It is all in one case, so it carries no checksum to check."}
            </Check>
            <Check ok={lookalike.ok}>{lookalike.text}</Check>
            <Check ok={check.sanctioned === null}>
              {check.sanctioned ? `It is on OFAC's SDN list, under ${check.sanctioned.name}.` : `It is not among the ${sanctioned.length} EVM addresses on OFAC's SDN list of ${listDate}.`}
            </Check>
            <Check ok={check.special === null}>{check.special ? specialWords(check.special) : "It is not a token contract or a burn address Vestiarion knows."}</Check>
          </ul>
        )}
        {check?.address &&
          check.matches
            .filter((match) => match.kind === "alike")
            .map((match) => <Comparison key={match.known.address} address={check.address!} match={match} />)}
      </section>
    </div>
  );
}
