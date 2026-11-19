// Fountain DAM × ArtCraft — the AI Studio's second engine (Sky, 2026-11-18:
// "integrate this into fountain DAM and our tools on Fountain DAM").
//
// ArtCraft gives the Studio the image models Gemini alone doesn't (Nano Banana
// Pro, GPT Image 2, Midjourney, Seedream, FLUX) and VIDEO (Veo, Sora, Kling,
// Seedance) — animate a can shot or an install photo straight from the library.
// Library assets live in the PUBLIC brand-assets bucket, so we hand ArtCraft
// their URLs; it downloads them itself (no inline-size ceiling like Gemini's).
//
// Generation is async (images ~10–60s, video minutes), so this is three calls:
//   GET                                 → { configured, catalog }
//   POST { action:'generate', kind:'image'|'video', model, prompt, assetIds?, imageUrls?,
//          uploadData?, uploadMime?, baseImageUrl?|baseImage?, brand?, useBrandGuidelines?,
//          aspect_ratio?, resolution?, quality?, duration_seconds?, generate_audio? }
//                                       → { job_token }
//   POST { action:'status', job_token } → { status, progress, done, result_url, preview_url, error }
//   POST { action:'save', url, kind, title?, brand?, type?, prompt?, model? }
//                                       → { asset }  (copied into brand-assets + dam.assets, tagged)
//
// Key: ARTCRAFT_API_KEY on this site (secret). Auth: DAM contributor, same as
// uploading / image-generate. Every generation is also logged to
// ops.artcraft_jobs (app 'fountain-dam') beside the other apps' ArtCraft use,
// so what the company spends on ArtCraft is one list.
import { preflight, json, requireRole } from './_shared/http.mjs';
import { db, q, publicUrl, storagePut, SUPABASE_URL, SERVICE_KEY } from './_shared/supabase.mjs';
import { CATALOG, apiKey, generateImage, generateVideo, jobStatus, upload, summarize, ArtcraftError } from './_shared/artcraft.mjs';
import { brandStyleText } from './image-generate.mjs';

const isType = (t) => typeof t === 'string' && /^[a-z0-9-]{1,40}$/.test(t);
const isBrand = (b) => typeof b === 'string' && /^[a-z0-9-]{1,48}$/.test(b);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const MAX_SAVE_BYTES = 200 * 1024 * 1024;

function safeSeg(v, fallback) {
  const c = String(v || '').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return c || fallback;
}

// Best-effort company-wide log (apbg-billing migration 20261118c). Never fails the call.
async function logJob(row) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/artcraft_jobs`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Content-Profile': 'ops', Prefer: 'return=minimal' },
      body: JSON.stringify(row), signal: AbortSignal.timeout(6000),
    });
  } catch (e) { console.warn('[artcraft] log failed', e?.message || e); }
}
async function patchJob(token, patch) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/artcraft_jobs?job_token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Content-Profile': 'ops', Prefer: 'return=minimal' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(6000),
    });
  } catch { /* best effort */ }
}

// Library assets → their public URLs (A, B, C… in the order the UI shows them).
async function assetUrls(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))].slice(0, 8);
  if (!uniq.length) return [];
  const rows = await db('GET', `assets?id=in.(${uniq.map(q).join(',')})&select=id,storage_path,brand`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return uniq.map((id) => byId.get(id)).filter(Boolean).map((r) => ({ url: publicUrl(r.storage_path), brand: r.brand }));
}

async function uploadDataUrl(dataUrl, mimeHint) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  const mime = m?.[1] || mimeHint || 'image/png';
  const bytes = Buffer.from(m ? m[2] : String(dataUrl || ''), 'base64');
  if (!bytes.length) return null;
  return upload('image', bytes, { filename: `ref.${EXT[mime] || 'png'}`, contentType: mime });
}

async function tagAsset(assetId, name) {
  const clean = String(name || '').trim().toLowerCase(); if (!clean) return;
  await db('POST', 'tags?on_conflict=name', { body: [{ name: clean }], prefer: 'resolution=merge-duplicates,return=minimal' });
  const tagRow = (await db('GET', `tags?name=eq.${q(clean)}&select=id`))[0];
  if (tagRow) await db('POST', 'asset_tags?on_conflict=asset_id,tag_id', { body: [{ asset_id: assetId, tag_id: tagRow.id }], prefer: 'resolution=merge-duplicates,return=minimal' });
}

export async function handler(event) {
  const pre = preflight(event); if (pre) return pre;
  const auth = await requireRole(event, 'contributor');
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  if (event.httpMethod === 'GET') return json({ configured: !!apiKey(), catalog: CATALOG });
  if (event.httpMethod !== 'POST') return json({ error: 'GET or POST' }, 405);
  if (!apiKey()) return json({ error: 'ArtCraft is not connected: set ARTCRAFT_API_KEY (secret) on the fountain-dam Netlify site and redeploy.' }, 503);

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return json({ error: 'invalid JSON' }, 400); }

  try {
    if (p.action === 'generate') {
      const kind = p.kind === 'video' ? 'video' : 'image';
      const model = String(p.model || '');
      const pool = kind === 'video' ? CATALOG.video_models : CATALOG.image_models;
      if (!pool.includes(model)) return json({ error: `Unknown ${kind} model: ${model}` }, 400);

      const refs = await assetUrls(p.assetIds);
      const urls = [
        ...(p.baseImageUrl && /^https?:\/\//i.test(p.baseImageUrl) ? [p.baseImageUrl] : []),
        ...refs.map((r) => r.url),
        ...(Array.isArray(p.imageUrls) ? p.imageUrls.filter((u) => /^https?:\/\//i.test(u)).slice(0, 4) : []),
      ];
      const tokens = [];
      if (p.baseImage) { const t = await uploadDataUrl(p.baseImage, p.baseMime); if (t) tokens.push(t); }
      if (p.uploadData) { const t = await uploadDataUrl(p.uploadData, p.uploadMime); if (t) tokens.push(t); }

      const brand = isBrand(p.brand) ? p.brand : refs[0]?.brand;
      const style = p.useBrandGuidelines && brand ? await brandStyleText(brand).catch(() => '') : '';
      const legend = refs.length ? `Reference images are given in order (A, B, C…). Keep every product, label and logo exactly as shown — do not redraw or relabel packaging.` : '';
      const editing = p.baseImage || p.baseImageUrl ? 'Edit the FIRST image per the instruction; preserve everything not mentioned.' : '';
      const prompt = [editing, legend, style, String(p.prompt || '').trim()].filter(Boolean).join('\n');
      if (!String(p.prompt || '').trim() && !urls.length && !tokens.length) return json({ error: 'prompt is required' }, 400);

      let res;
      if (kind === 'image') {
        // ArtCraft takes URLs OR media tokens for references, not both: when a
        // file was uploaded, upload the URL refs too isn't possible cheaply, so
        // tokens win and URL refs are fetched-and-uploaded alongside.
        let image_urls = urls, image_media_tokens = tokens;
        if (tokens.length && urls.length) {
          for (const u of urls) {
            const r = await fetch(u); if (!r.ok) continue;
            image_media_tokens.push(await upload('image', Buffer.from(await r.arrayBuffer()), { filename: 'ref', contentType: r.headers.get('content-type') || 'image/png' }));
          }
          image_urls = [];
        }
        res = await generateImage({
          model, prompt, image_urls, image_media_tokens,
          aspect_ratio: p.aspect_ratio, resolution: p.resolution, quality: p.quality,
        });
      } else {
        // Video: the first picture is the start frame; the rest are references.
        const [first, ...rest] = urls;
        res = await generateVideo({
          model, prompt,
          duration_seconds: Number(p.duration_seconds) || undefined, aspect_ratio: p.aspect_ratio,
          resolution: p.resolution, generate_audio: !!p.generate_audio,
          ...(tokens.length ? { start_frame_image_media_token: tokens[0] } : first ? { start_frame_image_url: first } : {}),
          reference_image_urls: tokens.length ? urls : rest,
        });
      }
      await logJob({
        kind, model, prompt: String(p.prompt || '').slice(0, 4000), app: 'fountain-dam',
        params: { aspect_ratio: p.aspect_ratio, resolution: p.resolution, brand, assetIds: p.assetIds || [], duration_seconds: p.duration_seconds },
        job_token: res.inference_job_token, all_job_tokens: res.all_job_tokens || [res.inference_job_token],
        status: 'pending', progress: 0, created_by: auth.user.id, created_by_email: auth.email,
      });
      return json({ job_token: res.inference_job_token });
    }

    if (p.action === 'status') {
      if (!/^jinf_[a-z0-9]+$/i.test(String(p.job_token || ''))) return json({ error: 'job_token required' }, 400);
      const s = summarize(await jobStatus(p.job_token));
      await patchJob(p.job_token, { status: s.status, progress: s.progress, result_url: s.result_url, preview_url: s.preview_url, media_token: s.media_token, error: s.failure });
      return json({ ...s, error: s.failure });
    }

    if (p.action === 'save') {
      // Only ArtCraft's own CDN results are copied — this is not a general URL fetcher.
      const u = String(p.url || '');
      let host = ''; try { host = new URL(u).hostname; } catch { /* bad url */ }
      if (!/(^|\.)r2\.dev$|(^|\.)fakeyou\.com$|(^|\.)storyteller\.ai$|(^|\.)getartcraft\.com$/.test(host)) return json({ error: 'Can only save ArtCraft results' }, 400);
      const r = await fetch(u);
      if (!r.ok) return json({ error: `Could not fetch result (${r.status})` }, 502);
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > MAX_SAVE_BYTES) return json({ error: 'Result too large to save' }, 413);
      const mime = (r.headers.get('content-type') || (p.kind === 'video' ? 'video/mp4' : 'image/png')).split(';')[0];
      const ext = EXT[mime] || (p.kind === 'video' ? 'mp4' : 'png');
      const title = String(p.title || (p.kind === 'video' ? 'AI video' : 'AI scene')).slice(0, 160);
      const path = `ai/${Date.now()}-${safeSeg(title, 'artcraft')}.${ext}`;
      await storagePut(path, bytes, mime);
      const rows = await db('POST', 'assets', {
        body: {
          storage_path: path, filename: `${safeSeg(title, 'artcraft')}.${ext}`, title, content_type: mime,
          type: isType(p.type) ? p.type : 'hero', brand: isBrand(p.brand) ? p.brand : 'shared', status: 'approved',
          description: p.prompt ? `ArtCraft ${p.model || ''}: ${String(p.prompt).slice(0, 900)}` : null,
        },
        prefer: 'return=representation',
      });
      const asset = rows[0];
      await tagAsset(asset.id, 'ai-generated');
      await tagAsset(asset.id, 'artcraft');
      if (p.kind === 'video') await tagAsset(asset.id, 'video');
      return json({ saved: true, asset: { id: asset.id, title, brand: asset.brand, type: asset.type, url: publicUrl(path) } });
    }

    return json({ error: `Unknown action: ${p.action}` }, 400);
  } catch (e) {
    if (e instanceof ArtcraftError) {
      return json({ error: e.status === 401 ? 'ArtCraft refused the API key — check ARTCRAFT_API_KEY on fountain-dam.' : e.message }, e.status >= 400 && e.status < 500 && e.status !== 401 ? e.status : 502);
    }
    console.error('artcraft error', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, e?.status || 500);
  }
}
