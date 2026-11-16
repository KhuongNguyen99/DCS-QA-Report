-- Add after schema.sql. Counts voice attempts, never audio or transcripts.
begin;
create table if not exists qa_private.voice_attempts (
  inspector_id uuid not null references auth.users(id),
  attempted_at timestamptz not null default now()
);
create index if not exists voice_attempts_inspector_time on qa_private.voice_attempts(inspector_id, attempted_at);
alter table qa_private.voice_attempts enable row level security;
revoke all on qa_private.voice_attempts from public, anon, authenticated;

create or replace function public.qa_authorize_voice(p_record_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform qa_private.require_inspector();
  if p_record_key is distinct from 'walkdown:general' and not exists (select 1 from public.qa_targets where key = p_record_key) then
    raise exception 'Unknown comment scope.';
  end if;
  -- Serialize each inspector's checks across all Edge Function workers.
  perform pg_catalog.pg_advisory_xact_lock(450008, pg_catalog.hashtext(auth.uid()::text));
  delete from qa_private.voice_attempts where attempted_at < now() - interval '1 day';
  if (select count(*) from qa_private.voice_attempts where inspector_id = auth.uid() and attempted_at > now() - interval '5 minutes') >= 10
    or (select count(*) from qa_private.voice_attempts where inspector_id = auth.uid()) >= 120 then
    return false;
  end if;
  insert into qa_private.voice_attempts(inspector_id) values (auth.uid());
  return true;
end;
$$;
revoke all on function public.qa_authorize_voice(text) from public, anon, authenticated;
grant execute on function public.qa_authorize_voice(text) to authenticated;
commit;
