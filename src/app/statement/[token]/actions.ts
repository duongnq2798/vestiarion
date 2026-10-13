"use server";

import "server-only";

import { refresh } from "next/cache";
import { after } from "next/server";
import { replyAsCustomer, submitCustomerRequest, type PortalField, type PortalSendOptions } from "@/lib/customer-portal/public";

/**
 * What a customer sends from its statement link (docs/superpowers/specs/2026-10-13-customer-portal-design.md P4, P5).
 * No session and no wallet: the link is the customer's only credential, checked with the invoice's customer and a daily
 * cap inside the database before anything is written. Nothing here settles an invoice. Nothing from a failure reaches
 * the customer but a fixed sentence. The email to the workspace's members, when there is one, goes after the answer.
 */

export interface StatementActionResult {
  ok: boolean;
  message: string;
  field?: PortalField;
}

function formString(formData: FormData, key: string, max = 4000): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.slice(0, max) : "";
}

const FAILED = "That did not work. Try again in a moment.";

/** The members' email waits until the customer has its answer. */
const SEND: PortalSendOptions = { defer: (work) => after(work) };

export async function submitStatementRequestAction(_previous: StatementActionResult, formData: FormData): Promise<StatementActionResult> {
  try {
    const answer = await submitCustomerRequest(formString(formData, "token", 100), {
      invoiceId: formString(formData, "invoiceId", 100),
      kind: formString(formData, "kind", 20),
      paidOn: formString(formData, "paidOn", 20),
      reference: formString(formData, "reference", 400),
      amount: formString(formData, "amount", 40),
      promisedOn: formString(formData, "promisedOn", 20),
      message: formString(formData, "message"),
    }, Date.now(), SEND);
    if (answer.ok) refresh();
    return answer;
  } catch (error) {
    console.error("statement request failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, message: FAILED, field: "form" };
  }
}

export async function replyOnStatementAction(_previous: StatementActionResult, formData: FormData): Promise<StatementActionResult> {
  try {
    const answer = await replyAsCustomer(formString(formData, "token", 100), { requestId: formString(formData, "requestId", 100), message: formString(formData, "message") }, Date.now(), SEND);
    if (answer.ok) refresh();
    return answer;
  } catch (error) {
    console.error("statement message failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, message: FAILED, field: "form" };
  }
}
