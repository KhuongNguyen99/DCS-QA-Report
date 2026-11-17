-- Add three independent equipment inspections to an existing named-walkdown
-- deployment. Run once in the Supabase SQL Editor; reruns are safe.
begin;

do $$
begin
  if to_regclass('public.qa_walkdowns') is null
    or to_regprocedure('qa_private.mark_walkdown_changed(uuid)') is null then
    raise exception 'Install named-walkdowns.sql before equipment-inspections.sql.';
  end if;
end;
$$;

-- Replace the original device/terminal-only checks before inserting NULL
-- terminal equipment. The three key/label pairs are the complete allowlist.
alter table public.qa_targets drop constraint if exists qa_targets_kind_check;
alter table public.qa_targets drop constraint if exists qa_targets_terminal_check;
alter table public.qa_targets drop constraint if exists qa_targets_check;
alter table public.qa_targets alter column terminal drop not null;
alter table public.qa_targets add constraint qa_targets_kind_check check (kind in ('device', 'terminal', 'equipment'));
alter table public.qa_targets add constraint qa_targets_terminal_check check ((kind = 'equipment' and terminal is null)
  or (kind in ('device', 'terminal') and terminal is not null and terminal ~ '^[A-H]$'));
alter table public.qa_targets add constraint qa_targets_check check ((kind = 'terminal' and key = 'terminal:' || terminal)
  or (kind = 'device' and key = 'device:' || label)
  or (kind = 'equipment' and ((key = 'equipment:control-box' and label = 'Control Box')
    or (key = 'equipment:solenoid-box' and label = 'Solenoid Box')
    or (key = 'equipment:transducer-panel' and label = 'Transducer Panel'))));

insert into public.qa_targets (key, kind, terminal, label) values
  ('equipment:control-box', 'equipment', null, 'Control Box'),
  ('equipment:solenoid-box', 'equipment', null, 'Solenoid Box'),
  ('equipment:transducer-panel', 'equipment', null, 'Transducer Panel')
on conflict (key) do nothing;

-- INSERT has no report-revision trigger. Only reports that receive new rows
-- advance, once per transaction; all previous evidence and status stay intact.
with added as (
  insert into public.qa_records(walkdown_id, key)
  select w.id, t.key from public.qa_walkdowns w cross join public.qa_targets t
  where t.kind = 'equipment'
  on conflict (walkdown_id, key) do nothing
  returning walkdown_id
)
update public.qa_walkdowns w set revision = revision + 1,
  updated_at = clock_timestamp(), last_change_txid = pg_catalog.txid_current()
where w.id in (select distinct walkdown_id from added);

commit;
