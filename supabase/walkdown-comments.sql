-- Add whole-walkdown comments to an existing deployment. Keeps all existing
-- comments and the 28 device / 8 terminal catalog unchanged. Safe to rerun.
begin;
alter table public.qa_comments alter column record_key drop not null;

create or replace function public.qa_load_state()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform qa_private.require_inspector();
  select jsonb_build_object(
    'project', jsonb_build_object('title', '450k skid x7 - DCS', 'revision', 3),
    'inspector', (select jsonb_build_object('id', u.id, 'email', u.email, 'name', i.display_name, 'isAdmin', i.is_admin)
      from auth.users u join public.qa_inspectors i on i.email = lower(u.email) where u.id = auth.uid()),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
      'key', r.key, 'complete', r.complete, 'completedAt', r.completed_at, 'completedBy', r.completed_by, 'updatedAt', r.updated_at,
      'quality', r.quality, 'qualityBy', r.quality_by, 'qualityAt', r.quality_at
    ) order by r.key) from public.qa_records r), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'recordKey', p.record_key, 'path', p.path, 'name', p.name, 'width', p.width, 'height', p.height,
      'createdAt', p.created_at, 'createdBy', p.created_by
    ) order by p.created_at, p.id) from public.qa_photos p where p.deleted_at is null and p.upload_state = 'ready'), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'recordKey', coalesce(c.record_key, 'walkdown:general'), 'text', c.text, 'createdAt', c.created_at, 'createdBy', c.created_by, 'authorName', c.author_name
    ) order by c.created_at, c.id) from public.qa_comments c), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.qa_add_comment(p_record_key text, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare author text; added public.qa_comments%rowtype;
begin
  perform qa_private.require_inspector();
  perform pg_catalog.pg_advisory_xact_lock(450007, 3);
  if p_record_key is distinct from 'walkdown:general' and not exists (select 1 from public.qa_targets where key = p_record_key) then
    raise exception 'Unknown comment scope.';
  end if;
  select i.display_name into author from public.qa_inspectors i join auth.users u on lower(u.email) = i.email where u.id = auth.uid();
  insert into public.qa_comments(record_key, text, created_by, author_name)
  values (nullif(p_record_key, 'walkdown:general'), trim(p_text), auth.uid(), author) returning * into added;
  if p_record_key <> 'walkdown:general' then perform qa_private.touch_record(p_record_key, false); end if;
  return to_jsonb(added);
end;
$$;

revoke all on function public.qa_load_state(), public.qa_add_comment(text,text) from public, anon, authenticated;
grant execute on function public.qa_load_state(), public.qa_add_comment(text,text) to authenticated;
commit;
