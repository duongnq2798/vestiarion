-- Composite foreign keys (spec §5.6, Line 2 as built).
--
-- Foreign-key checks bypass row-level security, so a single-column key lets a
-- row of one organization point at another organization's counterparty,
-- account or cycle run. Each such key becomes (org_id, column) → (org_id, id),
-- and the single-column key it replaces is dropped, so PostgREST still sees
-- exactly one relationship to embed.
--
-- Every existing row belongs to the founding organization, so every existing
-- link already satisfies the composite key.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
declare
  parent text;
begin
  foreach parent in array array['counterparties', 'accounts', 'cycle_runs']
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = parent || '_org_id_id_key'
         and conrelid = format('public.%I', parent)::regclass
    ) then
      execute format('alter table public.%I add constraint %I unique (org_id, id)', parent, parent || '_org_id_id_key');
    end if;
  end loop;
end $$;

do $$
declare
  spec record;
  old  record;
begin
  for spec in
    select * from (values
      ('invoices',          'counterparty_id', 'counterparties', 'cascade'),
      ('milestones',        'contractor_id',   'counterparties', 'cascade'),
      ('compliance_checks', 'counterparty_id', 'counterparties', 'cascade'),
      ('treasury_actions',  'from_account',    'accounts',       'set null (from_account)'),
      ('treasury_actions',  'to_account',      'accounts',       'set null (to_account)'),
      ('cycle_snapshots',   'cycle_run_id',    'cycle_runs',     'restrict')
    ) as s(child, col, parent, on_delete)
  loop
    -- Drop the single-column key on this column, whatever it is named.
    for old in
      select c.conname
        from pg_constraint c
       where c.contype = 'f'
         and c.conrelid = format('public.%I', spec.child)::regclass
         and c.confrelid = format('public.%I', spec.parent)::regclass
         and c.conkey = array[(select attnum from pg_attribute
                                where attrelid = format('public.%I', spec.child)::regclass and attname = spec.col)]::int2[]
    loop
      execute format('alter table public.%I drop constraint %I', spec.child, old.conname);
    end loop;

    if not exists (
      select 1 from pg_constraint
       where conname = spec.child || '_' || spec.col || '_org_fkey'
         and conrelid = format('public.%I', spec.child)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (org_id, %I) references public.%I (org_id, id) on delete %s',
        spec.child, spec.child || '_' || spec.col || '_org_fkey', spec.col, spec.parent, spec.on_delete
      );
    end if;
  end loop;
end $$;

-- cycle_snapshots is 1:1 with cycle_runs, and 0008 enforced that inline as a
-- plain `unique` on cycle_run_id — a single-column key that pre-dates tenancy
-- and, like the foreign keys above, applies across every organization's rows
-- together. Left alone it would intercept a cross-organization insert as a
-- duplicate-key error before the composite foreign key above ever runs, which
-- both hides the real (foreign-key) reason for the refusal and depends on no
-- two organizations' cycle runs ever colliding on id. Scope it to the
-- organization the same way, dropping the old constraint by shape (like the
-- foreign keys above) rather than by name, so a replay after this constraint
-- is already composite finds nothing matching and leaves it alone.
do $$
declare
  old record;
begin
  for old in
    select c.conname
      from pg_constraint c
     where c.contype = 'u'
       and c.conrelid = 'public.cycle_snapshots'::regclass
       and c.conkey = array[(select attnum from pg_attribute
                              where attrelid = 'public.cycle_snapshots'::regclass and attname = 'cycle_run_id')]::int2[]
  loop
    execute format('alter table public.cycle_snapshots drop constraint %I', old.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conname = 'cycle_snapshots_org_id_cycle_run_id_key'
       and conrelid = 'public.cycle_snapshots'::regclass
  ) then
    alter table public.cycle_snapshots add constraint cycle_snapshots_org_id_cycle_run_id_key unique (org_id, cycle_run_id);
  end if;
end $$;

-- Rollback: drop cycle_snapshots_org_id_cycle_run_id_key and add back
-- `unique (cycle_run_id)`; for each (child, col, parent, on_delete) above, drop
-- <child>_<col>_org_fkey and add back `foreign key (col) references
-- public.<parent>(id) on delete <rule without the column list>`; then drop the
-- three <parent>_org_id_id_key constraints.
