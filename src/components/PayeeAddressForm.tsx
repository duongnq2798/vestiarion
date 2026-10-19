"use client";

import { ArrowLeft, CircleCheck, PenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { keepPayeeAddressAction, submitPayeeAddressAction, type PayeeAddressResult } from "@/app/payee/[token]/actions";
import { PasskeyWalletOption } from "@/components/payee/PasskeyWalletOption";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { groupAddress, looksLikeAddress, moveOn, NOT_AN_ADDRESS, type PayeeLinkStatus } from "@/lib/payee-journey";

const INITIAL: PayeeAddressResult = { ok: false, message: "" };

/** Why Send my address is not pressable yet: a checklist read as a choice of one left a payee guessing (2026-10-02 test). */
export const SEND_HINT = "Tick all three boxes to send your address.";

/** The same, with the box that names the chain the payee chose (payee invoice link P2). */
export const SEND_HINT_WITH_CHAIN = "Tick all four boxes to send your address.";

/** What the payee ticks before sending an address the link cannot take back (freelancer journey R6). */
export const ADDRESS_CHECKS = [
  "It's my own wallet, and I can open it.",
  "It's not an exchange deposit address.",
  "The first and last characters match my wallet.",
] as const;

/** The box a payee who chose its chain ticks too, naming it (payee invoice link P2). */
export function chainCheck(chainLabel: string): string {
  return `My wallet receives USDC on ${chainLabel}.`;
}

/** The question over the chains a payee may choose among (P2). */
export const CHAIN_QUESTION = "Where does your wallet receive USDC?";

/** What a payee reads under a wallet the page just made for them, in place of the three boxes (payee passkey wallet P3). */
export const PASSKEY_WALLET_LINE =
  "Your passkey is the only way into this wallet, so keep it. To see or send what you're paid, open www.vestiarion.xyz/wallet with the same passkey.";

/**
 * The payee's address, in two screens (freelancer journey §4): the field, then the address read
 * back in fours with three boxes to tick before Send my address. Once it is sent, `onSent` gets the
 * link's status the action answers with, and the page moves on to the next step with it; an answer
 * without one refreshes the page instead (payee step advance S1, S2). `intro`, how it works, shows
 * with the field only, so the check screen has the address and the boxes and nothing else.
 *
 * `passkey`, when offered (payee passkey wallet P1), adds a secondary button under Continue that makes a passkey wallet,
 * or uses one made from an earlier link. Its address is read back under "Your new wallet" or "Your passkey wallet", with
 * one line about the passkey instead of the boxes, which guard against a mistyped or exchange address, and is sent the
 * same way (P3). While the passkey is asked, the typed path waits, so the two never cross (review finding 8).
 *
 * `chains`, on a link that lets the payee choose where it is paid (payee invoice link P2), puts a screen before the
 * field: which of them its wallet receives USDC on, `defaultChain` (the one on file) first chosen. The field then names the chain chosen,
 * the check screen adds a fourth box naming it, and the chain is sent with the address. The passkey wallet is offered
 * only on the chains in `passkeyChains`. `keep`, on a link that asks for an invoice when an address is on file, adds a
 * way to keep that address, shown masked, and go on to the invoice (P4).
 */
export default function PayeeAddressForm({
  token,
  chainLabel = "Arc testnet",
  orgName,
  intro,
  passkey = false,
  chains,
  defaultChain,
  passkeyChains = [],
  keep,
  onSent,
}: {
  token: string;
  chainLabel?: string;
  orgName: string;
  intro?: ReactNode;
  passkey?: boolean;
  chains?: ReadonlyArray<{ id: string; label: string }>;
  /** The chain on file, chosen first when it is one of `chains`. */
  defaultChain?: string;
  passkeyChains?: readonly string[];
  keep?: { masked: string };
  /** Takes the link's status once the address is sent or kept, for the page to move on as the action returns. */
  onSent?: (status: PayeeLinkStatus) => void;
}) {
  const router = useRouter();
  const choosing = chains !== undefined && chains.length > 1;
  const [step, setStep] = useState<"chain" | "enter" | "check">(choosing ? "chain" : "enter");
  const stepNow = useRef(step);
  useEffect(() => {
    stepNow.current = step;
  }, [step]);
  const [chain, setChain] = useState(choosing ? (chains.find((entry) => entry.id === defaultChain) ?? chains[0]).id : "");
  const [address, setAddress] = useState("");
  // Made (`Register`) or used (`Login`) on this page with a passkey, rather than typed (P3).
  const [madeWith, setMadeWith] = useState<"Register" | "Login" | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [error, setError] = useState("");
  // The chain the field and the fourth box name: the one chosen, or the one the link pays on.
  const label = choosing ? (chains.find((entry) => entry.id === chain)?.label ?? chainLabel) : chainLabel;
  const checks: readonly string[] = choosing ? [...ADDRESS_CHECKS, chainCheck(label)] : ADDRESS_CHECKS;
  const [checked, setChecked] = useState<boolean[]>(checks.map(() => false));
  const { state, formProps } = useActionForm(submitPayeeAddressAction, INITIAL, { onSuccess: (result) => moveOn(result, onSent, () => router.refresh()) });
  const passkeyHere = choosing ? passkeyChains.includes(chain) : passkey;

  if (state.ok) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-xl border border-proof-line bg-proof-soft px-4 py-3 text-sm text-ink">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
        {state.message}
      </p>
    );
  }

  if (step === "chain" && choosing) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setStep("enter");
        }}
        noValidate
        className="grid gap-4"
      >
        {intro}
        <RadioGroup
          legend={CHAIN_QUESTION}
          name="chainChoice"
          value={chain}
          onValueChange={(value) => {
            setChain(value);
            // A box ticked for one chain says nothing of another.
            setChecked(checks.map(() => false));
          }}
          options={chains.map((entry) => ({ value: entry.id, label: entry.label }))}
        />
        <p className="text-xs leading-5 text-ink-3">Choose the network your wallet shows your USDC on. Not sure? Ask {orgName} before you send your address.</p>
        <Button type="submit">Continue</Button>
      </form>
    );
  }

  if (step === "enter") {
    const next = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!looksLikeAddress(address)) {
        setError(NOT_AN_ADDRESS);
        return;
      }
      setError("");
      setStep("check");
    };
    return (
      <>
        <form onSubmit={next} noValidate className="grid gap-4">
          {!choosing && intro}
          <Field
            id="payee-address"
            label={`Your wallet address on ${label}`}
            description="Starts with 0x, then 40 letters and numbers. Copy it from your wallet, such as MetaMask."
            error={error || undefined}
          >
            <Input
              name="address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              required
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="0x…"
              disabled={passkeyPending}
            />
          </Field>
          <Button type="submit" disabled={passkeyPending}>
            Continue
          </Button>
          {passkeyHere && (
            <PasskeyWalletOption
              orgName={orgName}
              onPending={setPasskeyPending}
              onAddress={(made, mode) => {
                // A passkey answer that comes after the payee moved on is not theirs to apply.
                if (stepNow.current !== "enter") return;
                setAddress(made);
                setMadeWith(mode);
                setError("");
                setStep("check");
              }}
            />
          )}
          {choosing && (
            <Button type="button" variant="ghost" icon={<ArrowLeft />} onClick={() => setStep("chain")} disabled={passkeyPending}>
              Choose another network
            </Button>
          )}
        </form>
        {keep && !choosing && <KeepAddress token={token} orgName={orgName} masked={keep.masked} onSent={onSent} />}
      </>
    );
  }

  const trimmed = address.trim();
  const groups = groupAddress(trimmed);

  if (madeWith) {
    return (
      <form {...formProps} className="grid gap-5">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="address" value={trimmed} />
        {choosing && <input type="hidden" name="chain" value={chain} />}
        <div>
          <h2 className="text-base font-semibold text-ink">{madeWith === "Register" ? "Your new wallet" : "Your passkey wallet"}</h2>
          <p className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1 rounded-xl border border-line bg-raised px-3 py-2.5 font-mono text-[0.9375rem] tabular-nums text-ink">
            <span className="sr-only">{trimmed}</span>
            {groups.map((group, index) => (
              <span key={index} aria-hidden>
                {group}
              </span>
            ))}
          </p>
          <p className="mt-3 text-sm leading-6 text-ink-2">{PASSKEY_WALLET_LINE}</p>
        </div>
        <div className="grid gap-2">
          <p className="text-xs leading-5 text-ink-3">After you send it, this link can&apos;t change it. {orgName} confirms it before paying you.</p>
          <FormMessage tone={state.message ? "error" : "neutral"}>{state.message || null}</FormMessage>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            icon={<PenLine />}
            onClick={() => {
              setMadeWith(null);
              setAddress("");
              setStep("enter");
            }}
          >
            Use another address
          </Button>
          <SubmitButton pendingLabel="Sending…">Send my address</SubmitButton>
        </div>
      </form>
    );
  }

  const ready = checked.every(Boolean);
  return (
    <form {...formProps} className="grid gap-5">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="address" value={trimmed} />
      {choosing && <input type="hidden" name="chain" value={chain} />}
      <div>
        <h2 className="text-base font-semibold text-ink">Check your address</h2>
        <p className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1 rounded-xl border border-line bg-raised px-3 py-2.5 font-mono text-[0.9375rem] tabular-nums text-ink">
          <span className="sr-only">{trimmed}</span>
          {groups.map((group, index) => (
            <span key={index} aria-hidden className={index === 1 || index === groups.length - 1 ? "font-semibold" : undefined}>
              {group}
            </span>
          ))}
        </p>
      </div>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium text-ink">{choosing ? "Before you send it, tick all four" : "Before you send it, tick all three"}</legend>
        {checks.map((check, index) => (
          <Checkbox
            key={check}
            label={check}
            checked={checked[index]}
            onCheckedChange={(value) => setChecked((current) => current.map((item, at) => (at === index ? value === true : item)))}
          />
        ))}
      </fieldset>
      <div className="grid gap-2">
        <p className="text-xs leading-5 text-ink-3">After you send it, this link can&apos;t change it. To change it later, ask {orgName} for a new link.</p>
        <FormMessage tone={state.message ? "error" : "neutral"}>{state.message || null}</FormMessage>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" icon={<PenLine />} onClick={() => setStep("enter")}>
          Edit address
        </Button>
        <SubmitButton pendingLabel="Sending…" disabled={!ready} aria-describedby={ready ? undefined : "payee-send-hint"}>
          Send my address
        </SubmitButton>
      </div>
      {!ready && (
        <p id="payee-send-hint" className="-mt-2 text-right text-xs text-ink-3 max-sm:text-center">
          {choosing ? SEND_HINT_WITH_CHAIN : SEND_HINT}
        </p>
      )}
    </form>
  );
}

/**
 * Keep the address on file and go on to the invoice (payee invoice link P4): the link is used, as sending that address
 * again would use it, and nothing changes. The page moves on to the invoice step.
 */
function KeepAddress({ token, orgName, masked, onSent }: { token: string; orgName: string; masked: string; onSent?: (status: PayeeLinkStatus) => void }) {
  const router = useRouter();
  const { state, formProps } = useActionForm(keepPayeeAddressAction, INITIAL, { onSuccess: (result) => moveOn(result, onSent, () => router.refresh()) });
  if (state.ok) {
    return (
      <p role="status" className="mt-4 flex items-start gap-2 rounded-xl border border-proof-line bg-proof-soft px-4 py-3 text-sm text-ink">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
        {state.message}
      </p>
    );
  }
  return (
    <form {...formProps} className="mt-5 grid gap-3 border-t border-line pt-4">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm leading-6 text-ink-2">
        {orgName} already has an address for you: <span className="font-mono">{masked}</span>. Still yours?
      </p>
      <SubmitButton variant="secondary" pendingLabel="Keeping…">
        Keep this address
      </SubmitButton>
      <FormMessage tone={state.message ? "error" : "neutral"}>{state.message || null}</FormMessage>
    </form>
  );
}
