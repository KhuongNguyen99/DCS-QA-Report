-- PRONETA functional-test imports share each skid's existing QC revision.
-- Original files stay on the inspector's device; normalized evidence and hashes
-- are private, revision-pinned data and are frozen in approved snapshots.
begin;
do $$ begin
  if to_regclass('public.qa_report_revisions') is null then
    raise exception 'Install the current QC revision schema before importing test runs.';
  end if;
end; $$;

create table if not exists public.qa_test_runs (
  id uuid primary key,
  walkdown_id uuid not null references public.qa_walkdowns(id),
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4194304),
  run_version bigint not null default 1 check (run_version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);
create index if not exists qa_test_runs_walkdown on public.qa_test_runs(walkdown_id, created_at, id) where deleted_at is null;
alter table public.qa_test_runs enable row level security;
revoke all on public.qa_test_runs from public, anon, authenticated;
grant select on public.qa_test_runs to authenticated;
drop policy if exists qa_test_runs_read on public.qa_test_runs;
create policy qa_test_runs_read on public.qa_test_runs for select to authenticated
using ((select qa_private.is_inspector()) and deleted_at is null);
create or replace trigger qa_test_runs_draft_only before insert or update or delete on public.qa_test_runs
for each row execute function qa_private.guard_report_row();
create or replace trigger qa_test_runs_report_revision after insert or update or delete on public.qa_test_runs
for each row execute function qa_private.bump_report_revision();

create or replace function qa_private.test_run_info(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select data || jsonb_build_object('id', id, 'walkdownId', walkdown_id, 'runVersion', run_version,
    'createdAt', created_at, 'createdBy', created_by, 'updatedAt', updated_at, 'updatedBy', updated_by)
  from public.qa_test_runs where id = p_id;
$$;

create or replace function qa_private.test_runs_state(p_walkdown_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(qa_private.test_run_info(id) order by created_at, id), '[]'::jsonb)
  from public.qa_test_runs where walkdown_id = p_walkdown_id and deleted_at is null;
$$;

-- Authored graph tools are separate from the imported device/signal evidence.
-- References may become unavailable after replacing files; retain them so the
-- app and PDF can explain the unresolved calculation instead of guessing.
create or replace function qa_private.graph_tool_text(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_value) = 'string' and length(p_value #>> '{}') between 1 and 160
    and (p_value #>> '{}') = btrim(p_value #>> '{}', ' ' || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
      || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232)
      || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279))
    and (p_value #>> '{}') !~ ('[[:cntrl:]' || chr(127) || '-' || chr(159) || ']');
$$;

create or replace function qa_private.validate_graph_endpoint(p_endpoint jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare kind text; number numeric; bounds jsonb; range_start numeric; range_end numeric;
begin
  if jsonb_typeof(p_endpoint) is distinct from 'object' then
    raise exception 'A graph calculation endpoint must be a point, time, or trigger.';
  end if;
  kind := p_endpoint->>'kind';
  if kind = 'time' then
    if p_endpoint - array['kind','timeMs'] <> '{}'::jsonb then
      raise exception 'A manual graph calculation endpoint has unsupported fields.';
    end if;
  elsif kind = 'point' then
    if p_endpoint - array['kind','deviceId','graphKey','pointIndex','timeMs','value','sourceId','sourceRow'] <> '{}'::jsonb
      or jsonb_typeof(p_endpoint->'pointIndex') is distinct from 'number'
      or jsonb_typeof(p_endpoint->'value') is distinct from 'number' then
      raise exception 'A picked graph calculation point is invalid.';
    end if;
    number := (p_endpoint->>'pointIndex')::numeric;
    if number < 0 or number > 9999 or number <> trunc(number)
      or abs((p_endpoint->>'value')::numeric) > 1.7976931348623157e308 then
      raise exception 'A picked graph calculation point is outside the supported range.';
    end if;
    if p_endpoint ? 'sourceId' and qa_private.graph_tool_text(p_endpoint->'sourceId') is not true then
      raise exception 'A graph calculation source identifier is invalid.';
    end if;
    if p_endpoint ? 'sourceRow' then
      if jsonb_typeof(p_endpoint->'sourceRow') is distinct from 'number' then
        raise exception 'A graph calculation source row is invalid.';
      end if;
      number := (p_endpoint->>'sourceRow')::numeric;
      if number < 1 or number > 9007199254740991 or number <> trunc(number) then
        raise exception 'A graph calculation source row is invalid.';
      end if;
    end if;
  elsif kind = 'trigger' then
    if p_endpoint - array['kind','deviceId','graphKey','operator','threshold','timeRange'] <> '{}'::jsonb
      or coalesce(p_endpoint->>'operator','') not in ('>','>=','<','<=')
      or jsonb_typeof(p_endpoint->'threshold') is distinct from 'number' then
      raise exception 'A graph calculation trigger needs a comparison and numeric threshold.';
    end if;
    if abs((p_endpoint->>'threshold')::numeric) > 1.7976931348623157e308 then
      raise exception 'A graph calculation trigger exceeds the supported numeric range.';
    end if;
    if p_endpoint ? 'timeRange' then
      bounds := p_endpoint->'timeRange';
      if jsonb_typeof(bounds) is distinct from 'object' then
        raise exception 'A graph calculation trigger time range must contain startMs and endMs.';
      end if;
      if bounds - array['startMs','endMs'] <> '{}'::jsonb
        or jsonb_typeof(bounds->'startMs') is distinct from 'number'
        or jsonb_typeof(bounds->'endMs') is distinct from 'number' then
        raise exception 'A graph calculation trigger time range must contain only numeric startMs and endMs.';
      end if;
      range_start := (bounds->>'startMs')::numeric;
      range_end := (bounds->>'endMs')::numeric;
      if abs(range_start) > 8640000000000000 or abs(range_end) > 8640000000000000
        or range_start <> trunc(range_start) or range_end <> trunc(range_end) or range_start > range_end then
        raise exception 'A graph calculation trigger time range needs ordered whole-millisecond timestamps within the supported range.';
      end if;
    end if;
  else
    raise exception 'A graph calculation endpoint must be a point, time, or trigger.';
  end if;
  if kind in ('point','trigger') and (qa_private.graph_tool_text(p_endpoint->'deviceId') is not true
    or qa_private.graph_tool_text(p_endpoint->'graphKey') is not true) then
    raise exception 'A graph calculation must identify its source device and graph.';
  end if;
  if kind in ('point','time') then
    if jsonb_typeof(p_endpoint->'timeMs') is distinct from 'number' then
      raise exception 'A graph calculation time must be recorded in milliseconds.';
    end if;
    number := (p_endpoint->>'timeMs')::numeric;
    if abs(number) > 8640000000000000 or number <> trunc(number) then
      raise exception 'A graph calculation time is outside the supported range.';
    end if;
  end if;
end;
$$;

create or replace function qa_private.validate_graph_tools(p_tools jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare device_alias jsonb; graph jsonb; calculation jsonb; calculation_count integer := 0;
begin
  if jsonb_typeof(p_tools) is distinct from 'object' then
    raise exception 'Graph tools must contain versioned display names and graph settings.';
  end if;
  if p_tools - array['version','deviceNames','graphs'] <> '{}'::jsonb
    or p_tools->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_tools->'deviceNames') is distinct from 'array'
    or jsonb_typeof(p_tools->'graphs') is distinct from 'array' then
    raise exception 'Graph tools must contain versioned display names and graph settings.';
  end if;
  if jsonb_array_length(p_tools->'deviceNames') > 250 or jsonb_array_length(p_tools->'graphs') > 1000 then
    raise exception 'Graph tools support at most 250 device names and 1,000 graph settings.';
  end if;
  for device_alias in select value from jsonb_array_elements(p_tools->'deviceNames') loop
    if jsonb_typeof(device_alias) is distinct from 'object' then raise exception 'A graph tools device name is invalid.'; end if;
    if device_alias - array['deviceId','name'] <> '{}'::jsonb
      or qa_private.graph_tool_text(device_alias->'deviceId') is not true
      or qa_private.graph_tool_text(device_alias->'name') is not true then
      raise exception 'Graph tools names must be 1 to 160 characters without control characters.';
    end if;
  end loop;
  if (select count(*) <> count(distinct value->>'deviceId') from jsonb_array_elements(p_tools->'deviceNames')) then
    raise exception 'Graph tools device names must identify each device once.';
  end if;
  for graph in select value from jsonb_array_elements(p_tools->'graphs') loop
    if jsonb_typeof(graph) is distinct from 'object' then raise exception 'A graph tools setting is invalid.'; end if;
    if graph - array['deviceId','graphKey','name','style','measurements'] <> '{}'::jsonb
      or qa_private.graph_tool_text(graph->'deviceId') is not true
      or qa_private.graph_tool_text(graph->'graphKey') is not true
      or (graph ? 'name' and qa_private.graph_tool_text(graph->'name') is not true)
      or (graph ? 'style' and coalesce(graph->>'style','') not in ('auto','line','step','smooth')) then
      raise exception 'Graph tools require valid references, names, and line, step, or smooth styles.';
    end if;
    if graph ? 'measurements' then
      if jsonb_typeof(graph->'measurements') is distinct from 'array' then
        raise exception 'Graph calculations must be a list.';
      end if;
      if jsonb_array_length(graph->'measurements') > 20 then raise exception 'Each graph supports at most 20 calculations.'; end if;
      calculation_count := calculation_count + jsonb_array_length(graph->'measurements');
      for calculation in select value from jsonb_array_elements(graph->'measurements') loop
        if jsonb_typeof(calculation) is distinct from 'object' then raise exception 'A graph calculation is invalid.'; end if;
        if calculation - array['id','name','unit','start','end'] <> '{}'::jsonb
          or qa_private.graph_tool_text(calculation->'id') is not true
          or qa_private.graph_tool_text(calculation->'name') is not true
          or coalesce(calculation->>'unit','') not in ('s','min','h') then
          raise exception 'Graph calculations need a name and seconds, minutes, or hours as the unit.';
        end if;
        perform qa_private.validate_graph_endpoint(calculation->'start');
        perform qa_private.validate_graph_endpoint(calculation->'end');
      end loop;
      if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(graph->'measurements')) then
        raise exception 'Graph calculation identifiers must be unique within each graph.';
      end if;
    end if;
  end loop;
  if calculation_count > 500 then raise exception 'A test run supports at most 500 graph calculations.'; end if;
  if (select count(*) <> count(distinct (value->>'deviceId',value->>'graphKey')) from jsonb_array_elements(p_tools->'graphs')) then
    raise exception 'Graph tools settings must identify each graph once.';
  end if;
end;
$$;

create or replace function qa_private.validate_test_run(p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare item jsonb; station jsonb; module jsonb; device jsonb; channel jsonb; series jsonb; point jsonb;
  channel_count integer := 0; module_count integer := 0; point_count integer := 0;
  lower_time numeric; upper_time numeric; previous_time numeric; point_time numeric;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 4194304 then
    raise exception 'The normalized test run must be an object no larger than 4 MB.';
  end if;
  if p_data ?| array['id','walkdownId','runVersion','createdAt','createdBy','updatedAt','updatedBy','deletedAt','deletedBy'] then
    raise exception 'Test run identity and audit metadata are managed by the server.';
  end if;
  if p_data->'schemaVersion' is distinct from '1'::jsonb then raise exception 'Unsupported test run format. Import the files again.'; end if;
  if p_data ? 'graphTools' then perform qa_private.validate_graph_tools(p_data->'graphTools'); end if;
  if jsonb_typeof(p_data->'name') is distinct from 'string' or length(trim(p_data->>'name')) not between 1 and 160
    or (p_data->>'name') ~ '[[:cntrl:]]' then raise exception 'Enter a test run name between 1 and 160 characters.'; end if;
  if p_data ? 'comment' and (jsonb_typeof(p_data->'comment') is distinct from 'string' or length(p_data->>'comment') > 4000) then
    raise exception 'Keep test run and device comments to text of at most 4,000 characters.';
  end if;
  if jsonb_typeof(p_data->'software') is distinct from 'object'
    or jsonb_typeof(p_data->'software'->'name') is distinct from 'string'
    or length(trim(p_data->'software'->>'name')) not between 1 and 120
    or (p_data->'software'->>'name') ~ '[[:cntrl:]]'
    or jsonb_typeof(p_data->'software'->'version') is distinct from 'string'
    or length(trim(p_data->'software'->>'version')) not between 1 and 80
    or (p_data->'software'->>'version') ~ '[[:cntrl:]]' then
    raise exception 'Enter the test software name and version before saving the test run.';
  end if;
  if jsonb_typeof(p_data->'clock') is distinct from 'object'
    or coalesce(p_data->'clock'->>'basis','') not in ('source-local','absolute')
    or jsonb_typeof(p_data->'clock'->'timeZone') is distinct from 'string'
    or length(trim(p_data->'clock'->>'timeZone')) not between 1 and 120 then
    raise exception 'The test run clock basis and time zone are required.';
  end if;
  if coalesce(p_data->'clock'->'startMs', 'null'::jsonb) = 'null'::jsonb
    and coalesce(p_data->'clock'->'endMs', 'null'::jsonb) = 'null'::jsonb then
    if coalesce(p_data->'clock'->'start', 'null'::jsonb) <> 'null'::jsonb
      or coalesce(p_data->'clock'->'end', 'null'::jsonb) <> 'null'::jsonb then
      raise exception 'The test run has inconsistent time limits.';
    end if;
  else
    if jsonb_typeof(p_data->'clock'->'startMs') is distinct from 'number'
      or jsonb_typeof(p_data->'clock'->'endMs') is distinct from 'number'
      or jsonb_typeof(p_data->'clock'->'start') is distinct from 'string'
      or jsonb_typeof(p_data->'clock'->'end') is distinct from 'string' then
      raise exception 'The test run has inconsistent time limits.';
    end if;
    lower_time := (p_data->'clock'->>'startMs')::numeric;
    upper_time := (p_data->'clock'->>'endMs')::numeric;
    if lower_time < -8640000000000000 or upper_time > 8640000000000000 or lower_time > upper_time
      or lower_time <> trunc(lower_time) or upper_time <> trunc(upper_time) then
      raise exception 'The test run time limits are invalid.';
    end if;
  end if;
  if jsonb_typeof(p_data->'sources') is distinct from 'array' or jsonb_array_length(p_data->'sources') not between 1 and 20 then
    raise exception 'Import between 1 and 20 source files for a test run.';
  end if;
  for item in select value from jsonb_array_elements(p_data->'sources') loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'id') is distinct from 'string'
      or length(item->>'id') not between 1 and 160 or jsonb_typeof(item->'name') is distinct from 'string'
      or length(item->>'name') not between 1 and 260 or jsonb_typeof(item->'kind') is distinct from 'string'
      or length(item->>'kind') not between 1 and 40 or jsonb_typeof(item->'sha256') is distinct from 'string'
      or (item->>'sha256') !~ '^[0-9a-fA-F]{64}$' or jsonb_typeof(item->'size') is distinct from 'number'
      or (item->>'size')::numeric not between 1 and 10485760 then
      raise exception 'Every test source needs its filename, type, byte size, and SHA-256 hash.';
    end if;
  end loop;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_data->'sources')) then
    raise exception 'Test source identifiers must be unique.';
  end if;
  if jsonb_typeof(p_data->'stations') is distinct from 'array' or jsonb_array_length(p_data->'stations') > 64 then
    raise exception 'The test run station list is invalid or too large.';
  end if;
  for station in select value from jsonb_array_elements(p_data->'stations') loop
    if jsonb_typeof(station) is distinct from 'object' or jsonb_typeof(station->'id') is distinct from 'string'
      or length(station->>'id') not between 1 and 160 or jsonb_typeof(station->'modules') is distinct from 'array' then
      raise exception 'The test run station or module metadata is invalid.';
    end if;
    module_count := module_count + jsonb_array_length(station->'modules');
    for module in select value from jsonb_array_elements(station->'modules') loop
      if jsonb_typeof(module) is distinct from 'object' or jsonb_typeof(module->'parameters') is distinct from 'array'
        or jsonb_array_length(module->'parameters') > 1000 then raise exception 'The module parameters are invalid or too large.'; end if;
    end loop;
  end loop;
  if module_count > 256 then raise exception 'A test run can contain at most 256 modules.'; end if;
  if jsonb_typeof(p_data->'devices') is distinct from 'array' or jsonb_array_length(p_data->'devices') > 250
    or jsonb_typeof(p_data->'unassignedChannels') is distinct from 'array'
    or jsonb_array_length(p_data->'unassignedChannels') > 500 then raise exception 'The test run device/channel list is invalid or too large.'; end if;
  for device in select value from jsonb_array_elements(p_data->'devices') loop
    if jsonb_typeof(device) is distinct from 'object' or jsonb_typeof(device->'id') is distinct from 'string'
      or length(device->>'id') not between 1 and 160 or jsonb_typeof(device->'name') is distinct from 'string'
      or length(device->>'name') not between 1 and 160 or coalesce(device->>'status','') not in ('Passed','Failed','Not tested')
      or jsonb_typeof(device->'channels') is distinct from 'array' then raise exception 'The device test result is invalid.'; end if;
    if device ? 'manualStatus' and (jsonb_typeof(device->'manualStatus') is distinct from 'string'
      or coalesce(device->>'manualStatus','') not in ('Passed','Failed')) then
      raise exception 'A manual device result must be Passed or Failed. Remove the manual result to use the recorded result.';
    end if;
    if device ? 'comment' and (jsonb_typeof(device->'comment') is distinct from 'string' or length(device->>'comment') > 4000) then
      raise exception 'Keep test run and device comments to text of at most 4,000 characters.';
    end if;
  end loop;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_data->'devices')) then
    raise exception 'Test device identifiers must be unique.';
  end if;
  for channel in
    select c.value from jsonb_array_elements(p_data->'devices') d cross join lateral jsonb_array_elements(d.value->'channels') c
    union all select value from jsonb_array_elements(p_data->'unassignedChannels')
  loop
    channel_count := channel_count + 1;
    if jsonb_typeof(channel) is distinct from 'object' or jsonb_typeof(channel->'id') is distinct from 'string'
      or length(channel->>'id') not between 1 and 220 or coalesce(channel->>'status','') not in ('Passed','Failed','Not tested','Not applicable')
      or jsonb_typeof(channel->'parameters') is distinct from 'array' or jsonb_array_length(channel->'parameters') > 1000
      or jsonb_typeof(channel->'series') is distinct from 'array' or jsonb_array_length(channel->'series') > 32 then
      raise exception 'A test channel has invalid results, parameters, or measurement series.';
    end if;
    for series in select value from jsonb_array_elements(channel->'series') loop
      if jsonb_typeof(series) is distinct from 'object' or coalesce(series->>'kind','') not in ('analog','digital')
        or jsonb_typeof(series->'points') is distinct from 'array' then raise exception 'A measurement series is invalid.'; end if;
      point_count := point_count + jsonb_array_length(series->'points');
      previous_time := null;
      for point in select value from jsonb_array_elements(series->'points') loop
        if point ? 'excluded' and jsonb_typeof(point->'excluded') is distinct from 'boolean' then
          raise exception 'A recorded event''s excluded flag must be true or false.';
        end if;
        if jsonb_typeof(point) is distinct from 'object' or jsonb_typeof(point->'timeMs') is distinct from 'number'
          or jsonb_typeof(point->'valid') is distinct from 'boolean' or lower_time is null then
          raise exception 'Every measurement needs a valid timestamp within the shared run time span.';
        end if;
        point_time := (point->>'timeMs')::numeric;
        if point_time < lower_time or point_time > upper_time or point_time <> trunc(point_time)
          or (previous_time is not null and point_time < previous_time) then
          raise exception 'Measurements must be ordered and inside the shared run time span.';
        end if;
        previous_time := point_time;
        if (point->>'valid')::boolean and (jsonb_typeof(point->'value') is distinct from 'number') then
          raise exception 'Valid measurements need a numeric value.';
        end if;
        if coalesce(jsonb_typeof(point->'value'),'null') not in ('number','null')
          or coalesce(jsonb_typeof(point->'previousValue'),'null') not in ('number','null') then
          raise exception 'Measurement values must be finite numbers or explicitly missing.';
        end if;
        if (jsonb_typeof(point->'value') = 'number' and abs((point->>'value')::numeric) > 1e100)
          or (jsonb_typeof(point->'previousValue') = 'number' and abs((point->>'previousValue')::numeric) > 1e100) then
          raise exception 'A measurement value exceeds the supported numeric range.';
        end if;
        if not exists (select 1 from jsonb_array_elements(p_data->'sources') s where s.value->>'id' = point->>'sourceId') then
          raise exception 'Every measurement must reference an imported source file.';
        end if;
      end loop;
    end loop;
  end loop;
  if channel_count > 500 or point_count > 10000 then raise exception 'A test run supports at most 500 channels and 10,000 measurement events.'; end if;
  if jsonb_typeof(p_data->'warnings') is distinct from 'array' or jsonb_array_length(p_data->'warnings') > 101 then
    raise exception 'The test import warnings are invalid or too large.';
  end if;
  for item in select value from jsonb_array_elements(p_data->'warnings') loop
    if jsonb_typeof(item) is distinct from 'string' or length(item #>> '{}') > 4000 then
      raise exception 'Import warnings must be readable text no longer than 4,000 characters.';
    end if;
  end loop;
  if p_data ? 'unparsedEvents' and (jsonb_typeof(p_data->'unparsedEvents') is distinct from 'array'
    or jsonb_array_length(p_data->'unparsedEvents') > 10000) then raise exception 'The unmatched event list is invalid or too large.'; end if;
end;
$$;

create or replace function public.qa_save_test_run(p_walkdown_id uuid, p_id uuid, p_data jsonb,
  p_expected_revision bigint, p_expected_run_version bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing public.qa_test_runs%rowtype;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  if p_id is null then raise exception 'Choose a valid test run identifier.'; end if;
  perform qa_private.validate_test_run(p_data);
  select * into existing from public.qa_test_runs where id = p_id;
  if found then
    if existing.walkdown_id <> p_walkdown_id then raise exception 'This test run belongs to another skid.'; end if;
    if existing.created_by <> auth.uid() and not qa_private.is_admin() then
      raise exception 'Only the importing inspector or a project administrator can change this test run.' using errcode = '42501';
    end if;
    if existing.deleted_at is not null then raise exception 'This test run was removed. Import it again as a new run.'; end if;
    if existing.data = p_data then return qa_private.test_run_info(p_id); end if;
    if p_expected_run_version is null or existing.run_version <> p_expected_run_version then
      raise exception 'This test run changed since you opened it. Refresh before saving.';
    end if;
    update public.qa_test_runs set data = p_data, run_version = run_version + 1,
      updated_at = clock_timestamp(), updated_by = auth.uid() where id = p_id;
  else
    if p_expected_run_version is not null then raise exception 'This test run no longer exists. Refresh before saving.'; end if;
    if (select count(*) from public.qa_test_runs where walkdown_id = p_walkdown_id and deleted_at is null) >= 20 then
      raise exception 'A skid can contain at most 20 active test runs. Remove an unused draft run first.';
    end if;
    insert into public.qa_test_runs(id, walkdown_id, data, created_by, updated_by)
    values(p_id, p_walkdown_id, p_data, auth.uid(), auth.uid());
  end if;
  return qa_private.test_run_info(p_id);
end;
$$;

create or replace function public.qa_delete_test_run(p_walkdown_id uuid, p_id uuid,
  p_expected_revision bigint, p_expected_run_version bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare existing public.qa_test_runs%rowtype;
begin
  perform qa_private.require_draft_revision(p_walkdown_id, p_expected_revision);
  select * into existing from public.qa_test_runs where id = p_id and walkdown_id = p_walkdown_id;
  if not found then raise exception 'Test run not found in this skid.'; end if;
  if existing.created_by <> auth.uid() and not qa_private.is_admin() then
    raise exception 'Only the importing inspector or a project administrator can remove this test run.' using errcode = '42501';
  end if;
  if existing.deleted_at is not null then return; end if;
  if p_expected_run_version is null or existing.run_version <> p_expected_run_version then
    raise exception 'This test run changed since you opened it. Refresh before removing it.';
  end if;
  update public.qa_test_runs set deleted_at = clock_timestamp(), deleted_by = auth.uid(),
    updated_at = clock_timestamp(), updated_by = auth.uid(), run_version = run_version + 1 where id = p_id;
end;
$$;

revoke all on function public.qa_save_test_run(uuid,uuid,jsonb,bigint,bigint),
  public.qa_delete_test_run(uuid,uuid,bigint,bigint) from public, anon, authenticated;
grant execute on function public.qa_save_test_run(uuid,uuid,jsonb,bigint,bigint),
  public.qa_delete_test_run(uuid,uuid,bigint,bigint) to authenticated;
revoke all on function qa_private.test_run_info(uuid), qa_private.test_runs_state(uuid),
  qa_private.validate_test_run(jsonb), qa_private.graph_tool_text(jsonb),
  qa_private.validate_graph_endpoint(jsonb), qa_private.validate_graph_tools(jsonb) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
