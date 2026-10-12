"use server";

import "server-only";

import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { planCrmDeal } from "@/lib/commands/crm";
import { addDeal, changeDeal, releaseDealLine, setDealAutoRelease } from "@/lib/commands/deals";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { readChangeForm, readDealForm, type DealFormField, type DealFormFields } from "@/lib/deals/input";
import { readDeal } from "@/lib/deals/read";
import { readShadowMode } from "@/lib/shadow-mode";

/**
 * Deals on Bills & receivables (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): confirming one, changing it,
 * releasing a line and the agent's release switch. By someone who may enter records (`records.write`), as adding a
 * receivable is, through the commands, inside the workspace's scope.
 */

export interface DealActionResult {
  ok: boolean;
  message: string;
  /** The field the refusal is about, on the New deal form. */
  field?: DealFormField;
  dealId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string, max = 20_000): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.slice(0, max) : "";
}

function dealFields(formData: FormData): DealFormFields {
  const text = (key: keyof DealFormFields, max?: number) => formString(formData, key, max);
  return {
    customerId: text("customerId", 64),
    customerName: text("customerName", 400),
    title: text("title", 400),
    currency: text("currency", 10),
    total: text("total", 40),
    startsOn: text("startsOn", 20),
    termsDays: text("termsDays", 10),
    externalRef: text("externalRef", 400),
    template: text("template", 20),
    depositPct: text("depositPct", 10),
    deliveryOn: text("deliveryOn", 20),
    milestones: text("milestones"),
    months: text("months", 10),
    dayOfMonth: text("dayOfMonth", 10),
    lines: text("lines"),
    edited: text("edited", 2),
    autoRelease: formData.get("autoRelease") === "on",
    idempotencyKey: text("idempotencyKey", 120),
  };
}

/**
 * Confirms a deal from the New deal form. The same form sent twice makes one deal (D12). A form a CRM's won deal filled
 * names its row (`crmRowId`): the deal is planned from it, with the CRM's deal id as its reference (HubSpot connector H11).
 */
export async function createDealAction(_previous: DealActionResult, formData: FormData): Promise<DealActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    // A deal in the business's own currency is taken in shadow mode only, as the invoice form takes a bill (D3).
    const shadowOn = await readShadowMode(db())
      .then((mode) => mode !== null)
      .catch(() => false);
    const read = readDealForm(dealFields(formData), { shadowOn });
    if (!read.ok) return { ok: false, message: read.message, field: read.field };
    const crmRowId = formString(formData, "crmRowId", 64);
    if (crmRowId && !UUID.test(crmRowId)) return { ok: false, message: "That deal is no longer in the list. Reload the page." };
    const outcome = crmRowId ? await planCrmDeal(consoleActor(auth), { rowId: crmRowId, draft: read.draft }) : await addDeal(consoleActor(auth), { draft: read.draft });
    return { ...consoleAnswer(outcome), ...(outcome.ok ? { dealId: outcome.dealId } : {}) };
  });
}

/**
 * Changes, cancels or reopens a deal from its page, against the version the page showed. Made from the changes a CRM
 * brought (`fromCrm`), the version says so and those changes count as reviewed (HubSpot connector H12).
 */
export async function changeDealAction(_previous: DealActionResult, formData: FormData): Promise<DealActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const dealId = formString(formData, "dealId", 64);
    if (!UUID.test(dealId)) return { ok: false, message: "That deal was not found." };
    // The total is typed in the deal's own currency: read it from the deal, never from the form.
    const deal = await readDeal(dealId);
    if (!deal.available) return { ok: false, message: "Deals are not set up on this deployment yet." };
    if (!deal.deal) return { ok: false, message: "That deal was not found." };
    const read = readChangeForm(
      {
        dealId,
        baseVersion: formString(formData, "baseVersion", 10),
        kind: formString(formData, "kind", 20),
        total: formString(formData, "total", 40),
        reason: formString(formData, "reason", 1000),
        lines: formString(formData, "lines"),
        idempotencyKey: formString(formData, "idempotencyKey", 120),
      },
      deal.deal.facts.currency
    );
    if (!read.ok) return { ok: false, message: read.message };
    // Made from a CRM's changes: the ones the form was filled in from (`crmSeen`), checked against the CRM's row again.
    const fromCrm = formString(formData, "fromCrm", 4) === "1" ? { seen: formString(formData, "crmSeen", 64) } : undefined;
    return consoleAnswer(await changeDeal(consoleActor(auth), { change: read.change, ...(fromCrm ? { fromCrm } : {}) }));
  });
}

/** Releases one line of a deal as a receivable. */
export async function releaseDealLineAction(_previous: DealActionResult, formData: FormData): Promise<DealActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const dealId = formString(formData, "dealId", 64);
    const lineId = formString(formData, "lineId", 64);
    if (!UUID.test(dealId) || !UUID.test(lineId)) return { ok: false, message: "That line is not on this deal." };
    return consoleAnswer(await releaseDealLine(consoleActor(auth), { dealId, lineId }));
  });
}

/** Turns the agent's release of a deal's lines on their invoice days on or off. */
export async function setDealAutoReleaseAction(_previous: DealActionResult, formData: FormData): Promise<DealActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const dealId = formString(formData, "dealId", 64);
    if (!UUID.test(dealId)) return { ok: false, message: "That deal was not found." };
    const on = formString(formData, "on", 10);
    if (on !== "true" && on !== "false") return { ok: false, message: "Choose whether the agent releases the lines." };
    return consoleAnswer(await setDealAutoRelease(consoleActor(auth), { dealId, on: on === "true" }));
  });
}
