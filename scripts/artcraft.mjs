#!/usr/bin/env node
// ArtCraft from the command line — for Claude sessions and staff shells.
//
//   ARTCRAFT_API_KEY=… node scripts/artcraft.mjs image "<prompt>" [--model nano_banana_pro] [--aspect square] [--ref URL]… [--out file.png]
//   ARTCRAFT_API_KEY=… node scripts/artcraft.mjs video "<prompt>" [--model veo_3p1_fast] [--seconds 6] [--start URL] [--ref URL]… [--out file.mp4]
//   ARTCRAFT_API_KEY=… node scripts/artcraft.mjs status jinf_…
//   ARTCRAFT_API_KEY=… node scripts/artcraft.mjs models
//   ARTCRAFT_API_KEY=… node scripts/artcraft.mjs probe
//
// The key comes ONLY from the environment (a Claude cloud environment secret,
// or your shell) — never pass it on the command line or commit it. Waits for the
// job, prints the result URL, and downloads it when --out is given.
// Jobs made here are not in dam.artcraft_jobs; use the AI Studio when the
// spend should be on the log.

import { writeFile } from 'node:fs/promises';
import { CATALOG, generateImage, generateVideo, waitFor, jobStatus, summarize, probeKey } from '../netlify/functions/_shared/artcraft.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = { ref: [] }; const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = rest[++i]; if (k === 'ref') flags.ref.push(v); else flags[k] = v; } else pos.push(a);
}
const prompt = pos.join(' ');

async function finish(token) {
  console.error(`job ${token} — waiting…`);
  const s = await waitFor(token, { onTick: (x) => console.error(`  ${x.status}${x.progress != null ? ` ${x.progress}%` : ''}`) });
  console.log(JSON.stringify(s, null, 2));
  if (s.result_url && flags.out) {
    const r = await fetch(s.result_url);
    await writeFile(flags.out, Buffer.from(await r.arrayBuffer()));
    console.error(`saved ${flags.out}`);
  }
  if (s.status !== 'complete_success') process.exitCode = 1;
}

try {
  if (cmd === 'models') console.log(JSON.stringify(CATALOG, null, 2));
  else if (cmd === 'probe') console.log(JSON.stringify(await probeKey()));
  else if (cmd === 'status') console.log(JSON.stringify(summarize(await jobStatus(pos[0])), null, 2));
  else if (cmd === 'image') {
    const r = await generateImage({ model: flags.model || 'nano_banana_pro', prompt, aspect_ratio: flags.aspect || 'square', resolution: flags.resolution, quality: flags.quality, image_urls: flags.ref });
    await finish(r.inference_job_token);
  } else if (cmd === 'video') {
    const r = await generateVideo({ model: flags.model || 'veo_3p1_fast', prompt, duration_seconds: Number(flags.seconds || 6), aspect_ratio: flags.aspect || 'wide_sixteen_by_nine', resolution: flags.resolution, start_frame_image_url: flags.start, reference_image_urls: flags.ref, generate_audio: flags.audio === 'true' });
    await finish(r.inference_job_token);
  } else {
    console.error('usage: node scripts/artcraft.mjs image|video "<prompt>" [flags] | status <jinf_…> | models | probe');
    process.exitCode = 2;
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
