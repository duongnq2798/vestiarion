import type { InvoiceInput } from "./findings";

/**
 * The example (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC7): Northwind Design on file, and an invoice
 * in its name from a lookalike domain, with a new bank account in another country, a new phone number, a wallet made
 * to look like the one on file, and a message asking for the change. Every value is made up. Both IBANs pass their
 * check digits, so the example shows a change, not a typo; the phone numbers are in a range kept for drama.
 */
export const SAMPLE_INVOICE: InvoiceInput = {
  onFile: {
    name: "Northwind Design Ltd",
    email: "accounts@northwind-design.com",
    phone: "+44 20 7946 0958",
    wallet: "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d",
    iban: "GB74 HRBR 4040 4012 3456 78",
    bic: "HRBRGB2L",
    bank: "Harbour Bank",
  },
  invoice: {
    name: "Northwind Design",
    email: "Mara Lind <billing@northwlnd-design.com>",
    phone: "+44 20 7946 0123",
    wallet: "0x7a2d8f06c3e1b9a457d02c6e8f1b3a9d4e7ce10d",
    iban: "LT35 3250 0123 4567 8901",
    bic: "MNTALT2X",
    bank: "Mintaro Payments UAB",
  },
  message: [
    "Hi,",
    "",
    "Please note we have changed our bank following an audit. Our new bank details are on the attached invoice: please update your records and do not use the old account from today.",
    "",
    "The invoice is now overdue, so we need payment today. I am travelling and cannot take calls this week, so please reply only to this email.",
    "",
    "Thanks,",
    "Mara",
  ].join("\n"),
};
