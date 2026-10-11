/**
 * The CSV template the import has always offered: Vestiarion's own column names, an ISO due date and a plain amount.
 * A list in this shape is read with every column matched (import design B1); any other list is read as well.
 */
export const INVOICE_CSV_TEMPLATE =
  "direction,counterparty,amount,memo,po_reference,goods_received,due_date,early_pay_discount_pct,discount_deadline,currency\n" +
  "payable,Vendor name,100.00,Invoice memo,PO-100,true,2026-10-15,,,USDC";
