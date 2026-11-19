// ArtCraft Omni API client — AI image + video generation (Seedance, Kling, Veo,
// Sora, Nano Banana, GPT Image, FLUX, Midjourney, Seedream, …) on one key.
//
// THE KEY: env ARTCRAFT_API_KEY, marked secret (Sky, 2026-11-18). Never in a
// repo, never in a browser. apbg-billing holds it for /api/artcraft (and its
// daily probe, ops.fn_artcraft_health, watches the key for both sites).
// Fountain DAM holds its OWN copy of the key (ARTCRAFT_API_KEY, secret, on the
// fountain-dam Netlify site). This file is a COPY of apbg-billing
// netlify/functions/lib/artcraft.mjs — change both together.
//
// API reference: https://storyteller-docs.artcraft.team/ (source:
// github.com/storytold/artcraft-services, _docs/omni_api/artcraft_omni_api.md).
// Base URL is api.storyteller.ai — not a typo, that is ArtCraft's host.
// Generation is async: generate → inference_job_token → poll job_status until
// a terminal state → state.maybe_result.media_links.cdn_url is the file.
//
// Health: ops.fn_artcraft_health() reads the daily probe (artcraft-probe-cron.mjs),
// which uses probeKey() below — a revoked key turns red on the health board.

import { randomUUID } from 'node:crypto';

export const ARTCRAFT_BASE = process.env.ARTCRAFT_API_BASE || 'https://api.storyteller.ai';

export const apiKey = () => (process.env.ARTCRAFT_API_KEY || '').trim();

// Accepted values, from artcraft-services crates/enums (snake_case serde names).
// The API is the final word: an unknown value comes back as a 400 we pass on.
export const CATALOG = {
  image_models: [
    'nano_banana_pro', 'nano_banana_2', 'nano_banana', 'gpt_image_2', 'gpt_image_1p5', 'gpt_image_1',
    'seedream_5p0_pro', 'seedream_5_lite', 'seedream_4p5', 'seedream_4', 'midjourney_8', 'midjourney_7',
    'midjourney_7_niji', 'flux_pro_1p1_ultra', 'flux_pro_1p1', 'flux_1_dev', 'flux_1_schnell',
    'grok_imagine_image', 'qwen_edit_2511_angles', 'flux_2_lora_angles',
  ],
  video_models: [
    'seedance_2p0', 'seedance_2p0_fast', 'seedance_2p5', 'seedance_1p5_pro', 'seedance_1p0_lite',
    'kling_3p0_pro', 'kling_3p0_standard', 'kling_2p6_pro', 'kling_2p5_turbo_pro', 'kling_2p1_master',
    'veo_3p1', 'veo_3p1_fast', 'veo_3p1_lite', 'veo_3', 'veo_3_fast', 'veo_2',
    'sora_2_pro', 'sora_2', 'vidu_q3', 'vidu_q3_turbo', 'minimax_h3', 'minimax_h3_turbo', 'minimax_h3_ultra',
    'wan_3p0', 'wan_3p0_prime', 'grok_imagine_video_1p5', 'grok_imagine_video', 'flux_3', 'flux_3_draft',
  ],
  aspect_ratios: [
    'auto', 'square', 'square_hd', 'wide_sixteen_by_nine', 'wide_four_by_three', 'wide_three_by_two',
    'wide_five_by_four', 'wide_twenty_one_by_nine', 'tall_nine_by_sixteen', 'tall_three_by_four',
    'tall_two_by_three', 'tall_four_by_five', 'tall_nine_by_twenty_one',
  ],
  resolutions: ['one_k', 'two_k', 'three_k', 'four_k', 'four_eighty_p', 'seven_twenty_p', 'ten_eighty_p'],
  qualities: ['auto', 'low', 'medium', 'high', 'x_high', 'max'],
};

export const TERMINAL = new Set(['complete_success', 'complete_failure', 'dead', 'cancelled_by_user', 'cancelled_by_system']);

export class ArtcraftError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function call(path, { method = 'GET', json, form, key = apiKey(), timeoutMs = 60000 } = {}) {
  if (!key) throw new ArtcraftError('ARTCRAFT_API_KEY is not set', 503);
  const headers = { Authorization: `Bearer ${key}` };
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(`${ARTCRAFT_BASE}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok || data?.success === false) {
    const msg = data?.error_message || data?.error_reason || data?.error_code_str || data?.raw || `HTTP ${res.status}`;
    throw new ArtcraftError(`ArtCraft ${method} ${path}: ${msg}`, res.status, data);
  }
  return data;
}

// Drop undefined / null / '' / [] so we send only what the caller chose.
function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

const IMAGE_FIELDS = ['model', 'prompt', 'image_urls', 'image_media_tokens', 'resolution', 'aspect_ratio', 'quality',
  'image_batch_count', 'adjust_horizontal_angle', 'adjust_vertical_angle', 'adjust_zoom'];
const VIDEO_FIELDS = ['model', 'prompt', 'negative_prompt', 'duration_seconds', 'aspect_ratio', 'resolution', 'generate_audio',
  'video_batch_count', 'start_frame_image_url', 'end_frame_image_url', 'reference_image_urls', 'reference_video_urls',
  'reference_audio_urls', 'start_frame_image_media_token', 'end_frame_image_media_token', 'reference_image_media_tokens',
  'reference_video_media_tokens', 'reference_audio_media_tokens'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in (o || {})).map((k) => [k, o[k]]));

/** → { inference_job_token, all_job_tokens } */
export function generateImage(params, opts) {
  if (!params?.model) throw new ArtcraftError('model is required', 400);
  return call('/v1/omni_api/generate/image', { method: 'POST', json: clean({ ...pick(params, IMAGE_FIELDS), idempotency_token: params.idempotency_token || randomUUID() }), ...opts });
}

/** → { inference_job_token, all_job_tokens } */
export function generateVideo(params, opts) {
  if (!params?.model) throw new ArtcraftError('model is required', 400);
  return call('/v1/omni_api/generate/video', { method: 'POST', json: clean({ ...pick(params, VIDEO_FIELDS), idempotency_token: params.idempotency_token || randomUUID() }), timeoutMs: 240000, ...opts });
}

export const jobStatus = (token, opts) => call(`/v1/omni_api/job_status/job/${encodeURIComponent(token)}`, opts).then((d) => d.state);

export async function batchStatus(tokens, opts) {
  if (!tokens?.length) return [];
  const q = tokens.map((t) => `tokens=${encodeURIComponent(t)}`).join('&');
  const d = await call(`/v1/omni_api/job_status/batch?${q}`, opts);
  return d.job_states || [];
}

/** kind: 'image' | 'video' | 'audio'. bytes: Buffer/Uint8Array. → media_file_token (m_…) */
export async function upload(kind, bytes, { filename = 'upload', contentType, title } = {}, opts) {
  const form = new FormData();
  form.append('uuid_idempotency_token', randomUUID());
  form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename);
  if (title) form.append('maybe_title', title);
  const d = await call(`/v1/omni_api/upload/${kind}`, { method: 'POST', form, timeoutMs: 120000, ...opts });
  return d.media_file_token;
}

/** The useful parts of a job state, flat. */
export function summarize(state) {
  const r = state?.maybe_result || null;
  const links = r?.media_links || {};
  return {
    job_token: state?.job_token,
    status: state?.status?.status || 'unknown',
    progress: state?.status?.progress_percentage ?? null,
    failure: state?.status?.maybe_failure_category || null,
    result_url: links.cdn_url || null,
    preview_url: links.maybe_video_previews?.still || (links.maybe_thumbnail_template ? links.maybe_thumbnail_template.replace('{WIDTH}', '512') : null) || links.cdn_url || null,
    media_token: r?.entity_token || null,
    done: TERMINAL.has(state?.status?.status),
  };
}

/** Poll until terminal (or timeout). Returns summarize(state). */
export async function waitFor(token, { intervalMs = 5000, timeoutMs = 20 * 60000, onTick } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = summarize(await jobStatus(token));
    onTick?.(s);
    if (s.done) return s;
    if (Date.now() > until) return { ...s, timed_out: true };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Is the key still accepted? A made-up job token answers 404 to a good key and
 *  401 to a revoked one, and costs no credits. → { ok, status, detail } */
export async function probeKey(key = apiKey()) {
  if (!key) return { ok: false, status: 0, detail: 'ARTCRAFT_API_KEY is not set on apbg-billing' };
  try {
    const res = await fetch(`${ARTCRAFT_BASE}/v1/omni_api/job_status/job/jinf_000000000000000000000000000`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: 'ArtCraft refused the API key (revoked or API access switched off)' };
    if (res.status >= 500) return { ok: false, status: res.status, detail: `ArtCraft API error ${res.status}` };
    return { ok: true, status: res.status, detail: 'key accepted' };
  } catch (e) {
    return { ok: false, status: 0, detail: `ArtCraft unreachable: ${e?.message || e}` };
  }
}
