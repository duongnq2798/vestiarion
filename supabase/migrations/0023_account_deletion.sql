-- Deleting an account keeps the workspaces it created and the members it
-- invited (spec §10 step 5b).
--
-- 0015 declared the foreign keys to auth.users without an ON DELETE action,
-- so deleting a person who had created a workspace, invited a member or
-- recorded an invoice or milestone failed with a foreign-key violation. Each
-- becomes:
--   memberships.invited_by → set null  (the member stays; who invited them is forgotten)
--   invitations.invited_by → cascade   (an open invitation from a deleted
--                                        inviter could never be accepted anyway:
--                                        accept_invitation re-checks the inviter's role)
--   orgs.created_by        → set null  (the workspace stays)
--   invoices.created_by    → set null
--   milestones.created_by  → set null
-- memberships.user_id already cascades (0015), so a person's own memberships
-- go with them, and the 0020 trigger still refuses to delete the last owner
-- of a workspace: deleting that account fails with its message.
--
-- A separate file because it alters 0015's constraints. Each key is found by
-- shape (table, column, auth.users), whatever it is named, dropped, and added
-- again under a fixed name; the fixed name is excluded from the search, so a
-- replay finds nothing to drop and adds nothing.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
declare
  spec record;
  old  record;
begin
  for spec in
    select * from (values
      ('memberships', 'invited_by', 'set null', 'memberships_invited_by_account_fkey'),
      ('invitations', 'invited_by', 'cascade',  'invitations_invited_by_account_fkey'),
      ('orgs',        'created_by', 'set null', 'orgs_created_by_account_fkey'),
      ('invoices',    'created_by', 'set null', 'invoices_created_by_account_fkey'),
      ('milestones',  'created_by', 'set null', 'milestones_created_by_account_fkey')
    ) as s(child, col, on_delete, fixed_name)
  loop
    for old in
      select c.conname
        from pg_constraint c
       where c.contype = 'f'
         and c.conrelid = format('public.%I', spec.child)::regclass
         and c.confrelid = 'auth.users'::regclass
         and c.conkey = array[(select attnum from pg_attribute
                                where attrelid = format('public.%I', spec.child)::regclass and attname = spec.col)]::int2[]
         and c.conname <> spec.fixed_name
    loop
      execute format('alter table public.%I drop constraint %I', spec.child, old.conname);
    end loop;

    if not exists (
      select 1 from pg_constraint
       where conname = spec.fixed_name
         and conrelid = format('public.%I', spec.child)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references auth.users (id) on delete %s',
        spec.child, spec.fixed_name, spec.col, spec.on_delete
      );
    end if;
  end loop;
end $$;

-- Rollback (back to 0015's keys, with no delete action):
-- alter table public.memberships drop constraint if exists memberships_invited_by_account_fkey,
--   add constraint memberships_invited_by_fkey foreign key (invited_by) references auth.users (id);
-- alter table public.invitations drop constraint if exists invitations_invited_by_account_fkey,
--   add constraint invitations_invited_by_fkey foreign key (invited_by) references auth.users (id);
-- alter table public.orgs drop constraint if exists orgs_created_by_account_fkey,
--   add constraint orgs_created_by_fkey foreign key (created_by) references auth.users (id);
-- alter table public.invoices drop constraint if exists invoices_created_by_account_fkey,
--   add constraint invoices_created_by_fkey foreign key (created_by) references auth.users (id);
-- alter table public.milestones drop constraint if exists milestones_created_by_account_fkey,
--   add constraint milestones_created_by_fkey foreign key (created_by) references auth.users (id);
