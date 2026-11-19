// artcraft-probe-cron.mjs — is the ArtCraft key still accepted? Daily.
//
// Company rule: no credential ships without a health check. ARTCRAFT_API_KEY
// lives in this site's env and dies silently if ArtCraft revokes it. This asks
// ArtCraft about a made-up job (404 = key good, 401 = refused; no credits spent)
// and logs one ops.sync_log row (source 'artcraft', sync_type 'key_probe').
// ops.fn_artcraft_health() reads it, so a dead key turns red on the company
// health board and health-alert emails it. Scheduled in netlify.toml.
import { SUPABASE_URL, SERVICE_KEY } from './_shared/supabase.mjs';
import { probeKey } from './_shared/artcraft.mjs';


export async function handler() {
  const p = await probeKey();
  const now = new Date().toISOString();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Content-Profile': 'ops', Prefer: 'return=minimal' },
      body: JSON.stringify({
        source: 'artcraft', sync_type: 'key_probe', status: p.ok ? 'success' : 'error',
        error_message: p.ok ? null : p.detail, records_synced: 0,
        metadata: { http_status: p.status, detail: p.detail, site: 'fountain-dam' }, started_at: now, completed_at: now,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('[artcraft-probe] log row refused:', res.status, (await res.text()).slice(0, 300));
  } catch (e) { console.error('[artcraft-probe] log failed:', e?.message || e); }
  console.log('[artcraft-probe]', p);
  return { statusCode: 200, body: JSON.stringify(p) };
}
