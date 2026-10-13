"use client";

import { Save } from "lucide-react";
import { useState } from "react";
import { saveCashScenarioAction, type CurrencyActionResult } from "@/app/actions/currency";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { utcMinute } from "@/lib/copy";
import { formatRateValue } from "@/lib/money";

/**
 * Saving a cash scenario as a version, and the versions saved (docs/superpowers/specs/2026-10-13-currency-provenance-
 * design.md M7). A save is the next version of the scenario open, or version 1 of a new one; a version is never
 * changed, so a changed rate never rewrites what was saved before. Opening a version sets the levers to it. An owner or
 * admin saves; every member sees the list.
 */

/** A saved version as the section shows it: plain values, so it crosses from the server. */
export interface SavedScenarioView {
  id: string;
  scenarioId: string;
  version: number;
  name: string;
  levers: { horizon: 30 | 60 | 90; lateDays: number; costPct: number; costScope: "all" | "foreign"; choices: Record<string, "late" | "on_time" | "never"> };
  rates: Array<{ currency: string; perUsd: string; reference: { perUsd: string; source: string; at: string } | null }>;
  createdAt: string;
  /** Who saved it, by email, when the page could name them. */
  createdBy: string | null;
}

export interface ScenarioSaving {
  orgSlug: string;
  /** False before migration 0113 runs. */
  available: boolean;
  canSave: boolean;
  versions: SavedScenarioView[];
}

const INITIAL: CurrencyActionResult = { ok: false, message: "" };

/** One line for a saved version's rates: `SGD 1.4000 (reference 1.3512)`. */
function ratesLine(rates: SavedScenarioView["rates"]): string {
  return rates
    .map((rate) => `${rate.currency} ${formatRateValue(rate.perUsd)}${rate.reference ? ` (reference ${formatRateValue(rate.reference.perUsd)})` : ""}`)
    .join(", ");
}

export function ScenarioVersions({
  id,
  saving,
  levers,
  rates,
  open,
  onOpen,
  onSaved,
}: {
  id: string;
  saving: ScenarioSaving;
  /** The levers and typed rates as they stand, to save. */
  levers: SavedScenarioView["levers"];
  rates: Array<{ currency: string; perUsd: string; reference: { perUsd: string; source: string; at: string } | null }>;
  /** The scenario open, when a saved version was opened or saved here. */
  open: { scenarioId: string; version: number; name: string } | null;
  onOpen: (version: SavedScenarioView) => void;
  onSaved: (saved: { scenarioId: string; version: number; name: string }) => void;
}) {
  const [name, setName] = useState(open?.name ?? "");
  const [shownFor, setShownFor] = useState(open?.scenarioId ?? null);
  // A version opened from the list names the scenario saved next.
  if ((open?.scenarioId ?? null) !== shownFor) {
    setShownFor(open?.scenarioId ?? null);
    setName(open?.name ?? "");
  }
  const form = useActionForm(saveCashScenarioAction, INITIAL, {
    toastOnSuccess: true,
    onSuccess: (state) => {
      if (state.scenarioId && state.version) onSaved({ scenarioId: state.scenarioId, version: state.version, name: name.trim() });
    },
  });

  return (
    <div className="space-y-4 rounded-xl border border-line p-3.5">
      <div>
        <h3 className="text-sm font-medium text-ink">Saved scenarios</h3>
        <p className="text-xs leading-5 text-ink-3">
          A saved scenario keeps its levers and the rates typed into it. Saving again makes the next version; no version is ever changed.
        </p>
      </div>
      {!saving.available ? (
        <p className="text-sm text-ink-2">Saving scenarios is not set up on this deployment yet.</p>
      ) : !saving.canSave ? (
        <p className="text-sm text-ink-2">An owner or admin can save this scenario as a version.</p>
      ) : (
        <form {...form.formProps} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <input type="hidden" name="orgSlug" value={saving.orgSlug} />
          <input type="hidden" name="scenarioId" value={open?.scenarioId ?? ""} />
          <input type="hidden" name="levers" value={JSON.stringify(levers)} />
          <input type="hidden" name="rates" value={JSON.stringify(rates)} />
          <Field id={`${id}-scenario-name`} label="Scenario name">
            <Input name="name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Such as SGD weakens" />
          </Field>
          <SubmitButton icon={<Save />} pendingLabel="Saving…">
            {open ? `Save as version ${open.version + 1}` : "Save as a version"}
          </SubmitButton>
          <p className="text-xs text-ink-3 sm:col-span-2">
            {open ? `Saving makes version ${open.version + 1} of "${open.name}". Its earlier versions stay as they were.` : "Saving makes version 1 of a new scenario."}
          </p>
          <FormMessage className="sm:col-span-2" tone={form.state.message && !form.state.ok ? "error" : "neutral"}>
            {form.state.ok ? null : form.state.message}
          </FormMessage>
        </form>
      )}
      {saving.available && saving.versions.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {saving.versions.map((version) => (
            <li key={version.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3 py-2.5">
              <span className="min-w-0 text-sm text-ink">
                {version.name} <span className="text-ink-3">{`version ${version.version}`}</span>
                <span className="block text-xs text-ink-3">
                  {`Saved ${utcMinute(version.createdAt)}${version.createdBy ? ` by ${version.createdBy}` : ""}. ${version.levers.horizon} days, clients ${version.levers.lateDays} days late, bill costs ${version.levers.costPct}%`}
                  {version.rates.length > 0 ? `; rates typed: ${ratesLine(version.rates)}.` : "."}
                </span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => onOpen(version)} aria-label={`Open ${version.name}, version ${version.version}`}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
