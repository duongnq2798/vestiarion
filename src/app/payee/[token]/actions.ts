"use server";

import "server-only";

import { ADDRESS_CHECKSUM, CHAIN_CLOSED, NOT_AN_ADDRESS } from "@/lib/payee-journey";
import { PAYEE_FILE_MESSAGES, PAYEE_INVOICE_MESSAGES, type PayeeInvoiceField } from "@/lib/payee-invoice";
import { submitPayeeInvoice } from "@/lib/platform/payee-invoices";
import { keepPayeeAddress, submitPayeeAddress } from "@/lib/platform/payee-links";

/**
 * The payee's submission from a payee link (spec 2026-09-30-payee-links-design.md
 * §2 step 3). No session: the one-time link is the payee's only credential, and
 * whatever they enter waits for a member to confirm it before any payment.
 * Nothing from a failure reaches the payee but a fixed sentence. The same holds
 * for the chain a link lets them choose, the address on file they keep, and the
 * invoice they send (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md
 * P2, P4): an invoice waits for a member to add it, and is read by no model.
 */

export interface PayeeAddressResult {
  ok: boolean;
  message: string;
}

export interface PayeeInvoiceResult {
  ok: boolean;
  message: string;
  /** The field the refusal is about, so the form marks it. */
  field?: PayeeInvoiceField;
}

const INVALID_LINK = "This link is no longer valid. Ask the business that sent it for a new one.";
const TRY_AGAIN = "That did not work. Try again in a moment.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function submitPayeeAddressAction(_previous: PayeeAddressResult, formData: FormData): Promise<PayeeAddressResult> {
  try {
    // A chain only from a page that offered the choice; any other sends none, and the chain on file stays.
    const chain = formString(formData, "chain");
    const token = formString(formData, "token");
    const address = formString(formData, "address");
    const result = chain ? await submitPayeeAddress(token, address, { chain }) : await submitPayeeAddress(token, address);
    if (result.ok) {
      return result.unchanged
        ? { ok: true, message: `That is already the address ${result.orgName} has on file.` }
        : { ok: true, message: `Thanks. ${result.orgName} will confirm your address before paying you.` };
    }
    if (result.reason === "invalid_address") return { ok: false, message: NOT_AN_ADDRESS };
    if (result.reason === "checksum_address") return { ok: false, message: ADDRESS_CHECKSUM };
    if (result.reason === "chain_closed") return { ok: false, message: CHAIN_CLOSED };
    return { ok: false, message: INVALID_LINK };
  } catch {
    console.error("payee address submission failed");
    return { ok: false, message: TRY_AGAIN };
  }
}

/** The payee keeps the address on file, and goes on to send its invoice (P4). */
export async function keepPayeeAddressAction(_previous: PayeeAddressResult, formData: FormData): Promise<PayeeAddressResult> {
  try {
    const result = await keepPayeeAddress(formString(formData, "token"));
    if (result.ok) return { ok: true, message: `Kept the address ${result.orgName} has on file.` };
    return { ok: false, message: result.reason === "no_address" ? "There is no address on file to keep. Enter your address instead." : INVALID_LINK };
  } catch {
    console.error("payee address keep failed");
    return { ok: false, message: TRY_AGAIN };
  }
}

/** The payee's invoice (P4): the fields and an optional file, checked, read for text only, and sent for review. */
export async function submitPayeeInvoiceAction(_previous: PayeeInvoiceResult, formData: FormData): Promise<PayeeInvoiceResult> {
  try {
    const file = formData.get("file");
    const result = await submitPayeeInvoice(formString(formData, "token"), {
      invoiceNumber: formString(formData, "invoiceNumber"),
      amount: formString(formData, "amount"),
      dueDate: formString(formData, "dueDate"),
      note: formString(formData, "note"),
      file: file instanceof File && file.size > 0 ? file : null,
    });
    if (result.ok) return { ok: true, message: `Sent. ${result.orgName} reviews your invoice before adding it.` };
    switch (result.reason) {
      case "invalid":
        return { ok: false, message: PAYEE_INVOICE_MESSAGES[result.field], field: result.field };
      case "file":
        return { ok: false, message: PAYEE_FILE_MESSAGES[result.code], field: "file" };
      case "busy":
        return { ok: false, message: "Wait a few seconds, then send it again." };
      case "already_sent":
        return { ok: false, message: "This link already sent an invoice. To send another, ask the business for a new link." };
      case "failed_check":
        return { ok: false, message: "Check the invoice number, the amount and the due date, then send it again." };
      default:
        return { ok: false, message: INVALID_LINK };
    }
  } catch {
    console.error("payee invoice submission failed");
    return { ok: false, message: TRY_AGAIN };
  }
}
