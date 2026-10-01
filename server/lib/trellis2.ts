import { Client } from '@gradio/client';
import { getHfToken } from './env';
import { resolveMediaUrl } from './media';

/**
 * The owner's copy of microsoft/TRELLIS.2 (duplicated 2026-10-01). Two edits from the original:
 * DINOv3 loads from camenduru's copy (Meta gates the official repo; the licence allows copies), and
 * backgrounds are cut inside the Space with BiRefNet (MIT) instead of BRIA's RMBG-2.0 demo, which is
 * not licensed for commercial use.
 */
export const TRELLIS2_SPACE = 'https://dariushh-trellis2-3d-engine.hf.space';

// The Space's own slider ranges.
const RESOLUTIONS = ['512', '1024', '1536'] as const;
const FACE_TARGET = { min: 100000, max: 500000 };
const TEXTURE_SIZE = { min: 1024, max: 4096 };

export interface Trellis2Options {
  resolution?: number;
  faceTarget?: number;
  textureSize?: number;
  seed?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Image -> GLB on TRELLIS.2. Returns the Space's URL for the GLB.
 *
 * The Space keeps the generated model in its per-session state between /image_to_3d and
 * /extract_glb, so every generation gets its OWN client (its own session). A shared client
 * would let two people's generations overwrite each other's state.
 */
export async function generateWithTrellis2(image: any, options: Trellis2Options, token?: string): Promise<string> {
  const t = token || getHfToken();
  const client = await Client.connect(TRELLIS2_SPACE, t ? { hf_token: t as `hf_${string}` } : {});

  const resolution = RESOLUTIONS.find((r) => r === String(options.resolution)) || '1024';
  const faceTarget = Math.round(clamp(Number(options.faceTarget) || 300000, FACE_TARGET.min, FACE_TARGET.max));
  const textureSize = clamp(Math.round((Number(options.textureSize) || 2048) / 1024) * 1024, TEXTURE_SIZE.min, TEXTURE_SIZE.max);
  const seed = Number.isFinite(options.seed) ? Number(options.seed) : Math.floor(Math.random() * 2147483647);

  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);

  // Creates the session's output folder that /extract_glb writes into.
  await client.predict('/start_session', []);

  // Cuts the background (BiRefNet) and centres the object; a picture that already has a
  // transparent background is only cropped.
  const prep = await client.predict('/preprocess_image', { input: image });
  const prepared = (prep.data as any[])?.[0];
  if (!prepared) throw new Error('TRELLIS.2 could not prepare the image.');
  console.log(`[TRELLIS.2] background cut in ${secs()}s; building at ${resolution}...`);

  await client.predict('/image_to_3d', { image: prepared, seed, resolution });
  console.log(`[TRELLIS.2] built in ${secs()}s; exporting ${faceTarget} faces, ${textureSize}px texture...`);

  const exported = await client.predict('/extract_glb', { decimation_target: faceTarget, texture_size: textureSize });
  const [shown, download] = exported.data as any[];
  const glbUrl = resolveMediaUrl(download ?? shown);
  if (!glbUrl) throw new Error('TRELLIS.2 returned no model file.');
  console.log(`[TRELLIS.2] done in ${secs()}s`);
  return glbUrl;
}
