"use client";

import { AtSign, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { lookupAddressNameAction, type AddressNameLookup } from "@/app/actions/intake";
import { Button } from "@/components/ui/Button";
import { ARC_ADDRESS } from "@/lib/address-checksum";
import { isAddressName, shortened } from "@/lib/ens-words";

const WAIT_MS = 450;

/**
 * Under an address field (docs/superpowers/specs/2026-10-22-ens-address-names-design.md EN1-EN3): an ENS name or a
 * Basename typed into it is looked up, with Use this address to put the address it points to in the field; an address
 * typed or pasted shows its ENS name, when it has one. A name that does not look like the payee's is said so, as a
 * question to check, never a refusal. The field keeps an address only: a name is never saved.
 */
export function AddressNameHint({ orgSlug, value, payeeName, onUse }: { orgSlug: string; value: string; payeeName: string; onUse: (address: string) => void }) {
  const [lookup, setLookup] = useState<{ query: string; payee: string; result: AddressNameLookup } | null>(null);
  const query = value.trim();
  const wanted = isAddressName(query) || ARC_ADDRESS.test(query);

  useEffect(() => {
    if (!wanted) return;
    let current = true;
    const timer = setTimeout(() => {
      lookupAddressNameAction(orgSlug, query, payeeName)
        .then((result) => {
          if (current) setLookup({ query, payee: payeeName, result });
        })
        .catch(() => {
          if (current) setLookup({ query, payee: payeeName, result: { ok: false, message: "The name could not be looked up. Try again, or paste the address." } });
        });
    }, WAIT_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [orgSlug, query, payeeName, wanted]);

  // Only the answer for what the field holds now, compared with the payee's name as it reads now.
  const result = wanted && lookup?.query === query && lookup.payee === payeeName ? lookup.result : null;
  if (!result) return null;
  if (!result.ok) return <p className="text-xs text-ink-3">{result.message}</p>;
  const warn = result.matches === false && payeeName.trim() !== "";

  if (result.kind === "name") {
    if (!result.address) return <p className="text-xs text-ink-3">{result.name} points to no address.</p>;
    const address = result.address;
    return (
      <div className="grid gap-1.5 rounded-lg border border-line bg-surface p-2.5 text-xs">
        <p className="flex flex-wrap items-center gap-1.5 text-ink-2">
          <AtSign aria-hidden className="size-3.5 text-ink-3" />
          <span className="font-medium text-ink">{result.name}</span> points to <span className="break-all font-mono text-ink">{address}</span>
        </p>
        {warn && (
          <p className="flex items-start gap-1.5 text-held">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {result.name} does not look like {payeeName}&apos;s name. Check it with them, by a contact you had before, before you use it.
          </p>
        )}
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => onUse(address)}>
            Use this address ({shortened(address)})
          </Button>
        </div>
      </div>
    );
  }
  if (result.kind === "address" && result.name) {
    return (
      <p className={warn ? "flex items-start gap-1.5 text-xs text-held" : "flex items-center gap-1.5 text-xs text-ink-3"}>
        {warn ? <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <AtSign aria-hidden className="size-3.5" />}
        {warn
          ? `This address's ENS name is ${result.name}, which does not look like ${payeeName}'s name. Check it with them before you save it.`
          : `This address's ENS name is ${result.name}.`}
      </p>
    );
  }
  return null;
}
