-- What an invoice's document asked to be paid to (docs/superpowers/specs/2026-10-21-invoice-pay-to-hold-design.md IP1).
--
-- invoices gains `document_pay_to`, the 0x address the document an invoice was read from asks payment to: null for an
-- invoice typed by hand or a document that named none. The agent holds a payment whose invoice asked for an address
-- other than the counterparty's on file (`invoice.pay_to_differs`, IP2); it never pays this address. The table's grants
-- and tenant policies stay as they are.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.invoices add column if not exists document_pay_to text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'invoices_document_pay_to_check' and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_document_pay_to_check
      check (document_pay_to is null or document_pay_to ~ '^0x[0-9a-fA-F]{40}$');
  end if;
end $$;

-- PostgREST reads the new column at once, so the first invoice added with it is not refused as before 0136.
notify pgrst, 'reload schema';
