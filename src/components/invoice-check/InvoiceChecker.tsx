"use client";

import { CircleAlert, OctagonX, TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Marked } from "@/components/address-check/AddressChecker";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import type { SanctionedEntry } from "@/lib/address-check";
import { callScript } from "@/lib/invoice-check/call-script";
import { checkInvoice, FIELDS, type FieldKey, type FieldResult, type Finding, type InvoiceCheck, type InvoiceInput } from "@/lib/invoice-check/findings";
import { MESSAGE_MAX, type CueKind } from "@/lib/invoice-check/message";
import { SAMPLE_INVOICE } from "@/lib/invoice-check/sample";

/**
 * The invoice details check (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC2, IC5, IC6): each field on
 * file beside the invoice's, the message that came with it, and what the rules say a moment after someone stops
 * typing. There is no form to submit, so nothing typed can reach an address bar or a server.
 */

const ICON = "mt-0.5 size-4 shrink-0";
/** 16 px on a phone, so the browser does not zoom into the field; smaller beside a keyboard and mouse. */
const MONO_FIELD = "font-mono text-base sm:text-[0.8125rem]";
const MONO_KEYS = new Set<FieldKey>(["wallet", "iban", "account", "routing", "bic"]);
const FIELD_MAX = 200;
/** How long after the last keystroke the check runs, so a half-typed IBAN or domain is not called wrong. */
export const SETTLE_MS = 600;

const EMPTY: InvoiceInput = { onFile: {}, invoice: {}, message: "" };

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const LEVEL_WORD = { fix: "Fix", stop: "Stop", look: "Look" } as const;

function LevelIcon({ level }: { level: Finding["level"] }) {
  if (level === "look") return <TriangleAlert aria-hidden className={`${ICON} text-held`} />;
  if (level === "stop") return <OctagonX aria-hidden className={`${ICON} text-refused`} />;
  return <CircleAlert aria-hidden className={`${ICON} text-refused`} />;
}

const PRESSURE_WORDS: Record<Exclude<CueKind, "change" | "reason">, string> = {
  pressure: "presses you to pay quickly",
  no_call: "asks you not to call",
  secrecy: "asks you to keep it quiet",
};

function joined(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The headline: what to do, and the one reason that matters most (IC5). */
function Verdict({ check }: { check: InvoiceCheck }) {
  const lead = check.lead!;
  const stops = check.findings.filter((finding) => finding.level === "stop").length;
  if (check.verdict === "fix") {
    return (
      <Callout tone="refused" title={`Check what you typed: ${lead.title}`}>
        {lead.detail} If you copied it exactly, the invoice is wrong: ask the vendor for it on a call to a number you already had.
        {stops > 0 && ` There ${stops === 1 ? "is also 1 reason" : `are also ${stops} reasons`} to stop below.`}
      </Callout>
    );
  }
  if (check.verdict === "stop") {
    const pressure = check.pressure.filter((kind): kind is keyof typeof PRESSURE_WORDS => kind in PRESSURE_WORDS).map((kind) => PRESSURE_WORDS[kind]);
    return (
      <Callout tone="refused" title={`Do not pay yet: ${lead.title}`}>
        Call the vendor on a number you already had, not one from this invoice or email, before you pay. The script is below.
        {pressure.length > 0 && ` The message also ${joined(pressure)}, as fraudsters often do to get paid before anyone calls.`}
      </Callout>
    );
  }
  if (check.verdict === "look") {
    const total = check.findings.length;
    return (
      <Callout tone="held" title={`Look at ${total === 1 ? "one thing" : `${total} things`} before you pay`}>
        {capital(lead.title)}.{total > 1 ? " The others are below." : ""}
      </Callout>
    );
  }
  if (check.onFileEmpty) {
    return (
      <Callout title="Nothing on file to compare with">
        Paying this invoice is a first payment to these details: confirm them on a call first, as below.
      </Callout>
    );
  }
  if (check.compared === 0) {
    return (
      <Callout title="Nothing compared yet">
        {check.oneSided > 0 && check.fields.some((field) => field.outcome === "unread")
          ? "Some details are filled in on both sides but could not be read: see why under What was compared."
          : "Fill in the same detail on both sides to compare it."}
      </Callout>
    );
  }
  return (
    <Callout title="Nothing found">
      The {count(check.compared, "detail", "details")} filled in on both sides match{check.compared === 1 ? "es" : ""}
      {check.message ? ", and the message reads like no change request" : ""}.{check.comparedPayment === 0 ? " No bank account or wallet was compared." : ""} These
      checks cannot tell whether your records were changed by an earlier email: if these details are new to you, or you updated them recently, call first
      as below.
    </Callout>
  );
}

const OUTCOME_WORD: Record<FieldResult["outcome"], string> = {
  same: "Same",
  differs: "Different",
  invoice_only: "On the invoice only",
  file_only: "On file only",
  unread: "Not compared",
};

function Compared({ fields }: { fields: readonly FieldResult[] }) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {fields.map((field) => (
        <li key={field.key} className="px-3.5 py-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="font-medium text-ink">{field.label}</p>
            <p className={field.outcome === "differs" ? "font-medium text-refused" : "text-ink-3"}>{OUTCOME_WORD[field.outcome]}</p>
          </div>
          <dl className="mt-1.5 grid gap-1 text-ink-2 sm:grid-cols-[8rem_1fr]">
            {field.onFile !== null && (
              <>
                <dt className="text-xs font-medium text-ink-3 sm:text-sm">On file</dt>
                <dd className={`min-w-0 break-all ${MONO_KEYS.has(field.key) ? "font-mono text-[0.8125rem]" : ""}`}>{field.onFile}</dd>
              </>
            )}
            {field.invoice !== null && (
              <>
                <dt className="text-xs font-medium text-ink-3 sm:text-sm">On the invoice</dt>
                <dd className={`min-w-0 break-all ${MONO_KEYS.has(field.key) ? "font-mono text-[0.8125rem]" : ""}`}>{field.invoice}</dd>
              </>
            )}
          </dl>
          {field.note && <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{field.note}</p>}
        </li>
      ))}
    </ul>
  );
}

export function InvoiceChecker({ sanctioned }: { sanctioned: readonly SanctionedEntry[] }) {
  const id = useId();
  const [typed, setTyped] = useState<InvoiceInput>(EMPTY);
  // What the check reads: what was typed, once typing pauses (SETTLE_MS), or at once for the example and Clear.
  const [settled, setSettled] = useState<InvoiceInput>(EMPTY);
  const results = useRef<HTMLElement>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typed === settled) return;
    const timer = window.setTimeout(() => setSettled(typed), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [typed, settled]);

  const check = useMemo(() => checkInvoice(settled, sanctioned), [settled, sanctioned]);
  const script = useMemo(
    () =>
      callScript({
        vendor: settled.onFile.name?.trim() || settled.invoice.name?.trim() || null,
        phoneOnFile: settled.onFile.phone?.trim() || null,
        changed: check.onFileEmpty ? [] : check.changed,
        asked: !check.onFileEmpty && check.asked,
        wallet: Boolean(settled.invoice.wallet?.trim()),
      }),
    [settled, check]
  );
  const anything = Object.values(typed.onFile).some(Boolean) || Object.values(typed.invoice).some(Boolean) || typed.message !== "";
  const showScript = check.verdict !== "empty" && (check.verdict !== "fix" || check.findings.some((finding) => finding.level === "stop"));

  const now = (next: InvoiceInput) => {
    setTyped(next);
    setSettled(next);
  };
  const set = (side: "onFile" | "invoice", key: FieldKey, text: string) => setTyped((current) => ({ ...current, [side]: { ...current[side], [key]: text } }));

  return (
    <div className="space-y-8">
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-ink-2">
          <span className="font-medium text-ink">On file</span> means what you had before this invoice: your accounting software, your bank&apos;s saved
          payee, or a past invoice you paid. Never copy it from the email this invoice came with.
        </p>
        <p className="hidden grid-cols-2 gap-3 text-xs font-medium uppercase tracking-wide text-ink-3 sm:grid">
          <span>On file: from your records</span>
          <span>On this invoice</span>
        </p>
        {FIELDS.map((field, index) => (
          <div key={field.key} role="group" aria-labelledby={`${id}-${field.key}`}>
            <p id={`${id}-${field.key}`} className="text-sm font-semibold text-ink">
              {field.label}
            </p>
            <div className="mt-1.5 grid gap-3 sm:grid-cols-2">
              {(["onFile", "invoice"] as const).map((side) => (
                <Field
                  key={side}
                  id={`${id}-${field.key}-${side}`}
                  label={
                    <span className="text-xs font-medium text-ink-3">
                      {side === "onFile" ? "On file" : "On this invoice"}
                      <span className="sr-only">: {field.label}</span>
                    </span>
                  }
                >
                  <Input
                    ref={index === 0 && side === "onFile" ? firstField : undefined}
                    value={typed[side][field.key] ?? ""}
                    onChange={(event) => set(side, field.key, event.target.value)}
                    placeholder={field.placeholder[side]}
                    maxLength={FIELD_MAX}
                    inputMode={field.inputMode}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className={MONO_KEYS.has(field.key) ? MONO_FIELD : undefined}
                  />
                </Field>
              ))}
            </div>
          </div>
        ))}
        <Field
          id={`${id}-message`}
          optional
          label="The message that came with it"
          description="The email, or the invoice's note. It is read for the words requests to change payment details use. If you can, paste its From and Reply-To lines too (Gmail: Show original; Outlook: View source)."
        >
          <Textarea value={typed.message} onChange={(event) => setTyped((current) => ({ ...current, message: event.target.value }))} maxLength={MESSAGE_MAX} rows={6} spellCheck={false} />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              now({ onFile: { ...SAMPLE_INVOICE.onFile }, invoice: { ...SAMPLE_INVOICE.invoice }, message: SAMPLE_INVOICE.message });
              // On a phone the results sit below 18 fields: bring them into view, the headline first.
              window.setTimeout(() => {
                const box = results.current?.getBoundingClientRect();
                if (box && box.top > window.innerHeight) results.current?.scrollIntoView({ block: "start" });
              }, 0);
            }}
          >
            Try an example
          </Button>
          {anything && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                now(EMPTY);
                firstField.current?.focus();
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <section ref={results} aria-label="What the check found" className="scroll-mt-20 space-y-5">
        {/* Only the headline is announced as it changes, not every line under it. */}
        <div aria-live="polite" data-results>
          {check.verdict !== "empty" && <Verdict check={check} />}
        </div>
        {check.findings.length > 0 && (
          <ul className="space-y-3">
            {check.findings.map((finding, index) => (
              <li key={index} className="flex gap-2.5 text-sm leading-relaxed text-ink-2">
                <LevelIcon level={finding.level} />
                <span>
                  <span className="font-semibold text-ink">
                    {LEVEL_WORD[finding.level]}: {capital(finding.title)}.
                  </span>{" "}
                  {finding.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
        {check.walletPair && (
          <div className="space-y-2 rounded-xl border border-line bg-surface px-3.5 py-3">
            <div>
              <p className="text-xs font-medium text-ink-3">The wallet on file</p>
              <Marked address={check.walletPair.onFile} other={check.walletPair.invoice} leading={check.walletPair.leading} trailing={check.walletPair.trailing} />
            </div>
            <div>
              <p className="text-xs font-medium text-ink-3">The wallet on the invoice</p>
              <Marked address={check.walletPair.invoice} other={check.walletPair.onFile} leading={check.walletPair.leading} trailing={check.walletPair.trailing} />
            </div>
          </div>
        )}
        {check.fields.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">What was compared</h3>
            <Compared fields={check.fields} />
          </div>
        )}
        {showScript && (
          <div className="space-y-3 rounded-2xl border border-line bg-surface px-4 py-5 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-ink">The call to make before you pay</h3>
              <CopyButton value={script.join("\n\n")} variant="secondary">
                Copy the script
              </CopyButton>
            </div>
            <div className="space-y-2.5 text-sm leading-relaxed text-ink-2">
              {script.map((line, index) => (
                <p key={index} className={index === 0 ? "font-medium text-ink" : undefined}>
                  {line}
                </p>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
