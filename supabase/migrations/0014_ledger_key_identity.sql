-- Record which key signed each ledger entry.
--
-- Until now an entry carried a signature and nothing saying whose it was, so a
-- deployment holding the wrong key could not distinguish "this chain was
-- tampered with" from "I was handed the wrong key". Both produced the same
-- "signature does not verify". For a system whose central claim is a verifiable
-- audit trail, that false alarm is the expensive one.
--
-- The column is deliberately NOT part of body_hash or of the chain hash. It is
-- a label that selects which key to check against, not a claim that proves
-- anything: verification stays sound because the signature must still verify
-- under whatever key the label names. Including it in the hashes would also
-- have rewritten the body hash of every existing entry, which is precisely the
-- history this is meant to keep checkable.
--
-- Existing rows stay null. They were written before this existed, and null says
-- exactly that; verification falls back to the deployment's configured key for
-- them, which is what it already did for every row.
alter table public.ledger_entries
  add column if not exists signing_key_id text;

comment on column public.ledger_entries.signing_key_id is
  'First 16 hex of sha256 over the signing key''s SPKI DER; null for entries written before key identity existed. A label for selecting the verifying key, outside both hashes and not itself authenticated.';

-- The 7-argument version has to go rather than gain an overload: PostgREST
-- resolves an RPC by name and argument names, and leaving both would let a
-- caller silently reach the one that records no key.
drop function if exists public.append_ledger_entry(text, text, text, text, jsonb, text, text);

create or replace function public.append_ledger_entry(
  p_actor          text,
  p_domain         text,
  p_action         text,
  p_summary        text,
  p_detail         jsonb,
  p_body_hash      text,
  p_signature      text,
  p_signing_key_id text default null
) returns ledger_entries
language plpgsql
as $$
declare
  v_prev_hash text;
  v_hash      text;
  v_row       ledger_entries;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger'));

  select hash into v_prev_hash from ledger_entries order by seq desc limit 1;
  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));

  v_hash := encode(digest(v_prev_hash || p_body_hash || p_signature, 'sha256'), 'hex');

  insert into ledger_entries (actor, domain, action, summary, detail,
                              body_hash, signature, prev_hash, hash, signing_key_id)
  values (p_actor, p_domain, p_action, p_summary, coalesce(p_detail, '{}'::jsonb),
          p_body_hash, p_signature, v_prev_hash, v_hash, p_signing_key_id)
  returning * into v_row;

  return v_row;
end;
$$;

-- Rollback (restores the unlabelled append; recorded ids survive in the column
-- until it is dropped, and dropping it discards them permanently):
-- drop function if exists public.append_ledger_entry(text, text, text, text, jsonb, text, text, text);
-- create or replace function public.append_ledger_entry(
--   p_actor text, p_domain text, p_action text, p_summary text,
--   p_detail jsonb, p_body_hash text, p_signature text
-- ) returns ledger_entries
-- language plpgsql
-- as $$
-- declare
--   v_prev_hash text; v_hash text; v_row ledger_entries;
-- begin
--   perform pg_advisory_xact_lock(hashtext('vestiarion_ledger'));
--   select hash into v_prev_hash from ledger_entries order by seq desc limit 1;
--   v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));
--   v_hash := encode(digest(v_prev_hash || p_body_hash || p_signature, 'sha256'), 'hex');
--   insert into ledger_entries (actor, domain, action, summary, detail,
--                               body_hash, signature, prev_hash, hash)
--   values (p_actor, p_domain, p_action, p_summary, coalesce(p_detail, '{}'::jsonb),
--           p_body_hash, p_signature, v_prev_hash, v_hash)
--   returning * into v_row;
--   return v_row;
-- end;
-- $$;
-- alter table public.ledger_entries drop column signing_key_id;
