-- ArtCraft belongs to Fountain DAM (Sky, 2026-11-19: "why isn't this just all
-- on fountain dam … that should be its own"). The job log first shipped as
-- ops.artcraft_jobs from apbg-billing (its 20261118c); it held no rows and moves
-- here, into the schema this repo owns. Same rule as every dam table: RLS on, no
-- permissive policies — only this site's service-role functions touch it.
alter table ops.artcraft_jobs set schema dam;
drop policy if exists artcraft_jobs_internal_read on dam.artcraft_jobs;
revoke all on dam.artcraft_jobs from anon, authenticated;
alter table dam.artcraft_jobs alter column app set default 'fountain-dam';

-- The key's daily probe now runs from this site (netlify/functions/artcraft-probe-cron.mjs);
-- ops.fn_artcraft_health() still reads its ops.sync_log row and sits on the company
-- health board. Only the fix-it text changes, to name the site that holds the key.
create or replace function ops.fn_artcraft_health()
 returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
 language plpgsql
 stable security definer
 set search_path to 'ops', 'public'
as $function$
declare r ops.sync_log%rowtype;
begin
  select * into r from ops.sync_log s
   where s.source = 'artcraft' and s.sync_type = 'key_probe'
   order by s.completed_at desc nulls last limit 1;
  check_name := 'artcraft_key';
  last_event_at := r.completed_at;
  age_seconds := case when r.completed_at is null then null else extract(epoch from (now() - r.completed_at))::int end;
  if r.completed_at is null then
    status := 'yellow';
    detail := 'ArtCraft key probe has not run yet (daily 14:17 UTC, artcraft-probe-cron on fountain-dam)';
  elsif r.status <> 'success' then
    status := 'red';
    detail := coalesce(r.error_message, 'ArtCraft refused the key')
      || ' — Fountain DAM''s AI Studio cannot use ArtCraft. Fix: a new key from app.getartcraft.com → Account → Settings → API Keys as ARTCRAFT_API_KEY (secret) on the fountain-dam Netlify site, then redeploy.';
  elsif r.completed_at < now() - interval '2 days' then
    status := 'yellow';
    detail := 'ArtCraft key last checked ' || greatest(0, extract(epoch from (now() - r.completed_at))::int / 86400) || 'd ago (daily probe on fountain-dam)';
  else
    status := 'green';
    detail := 'ArtCraft key accepted (fountain-dam)';
  end if;
  return next;
end $function$;
