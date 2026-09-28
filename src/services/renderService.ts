import type { CameraPackage } from './cameraPackage';

/**
 * What Seedream gets as image 1. An edit model copies whatever that image shows, so the textured
 * previs leaks its CG look; a pass with no colour or surface detail does not. Blur suits interiors,
 * clay (flat grey tones, edges kept) suits exteriors.
 */
export type RenderPass = 'blur' | 'clay' | 'full';

/** Interior scenes default to blur, exterior ones to clay, from the slugline ("EXT. STREET — DAY"). */
export function defaultPassFor(sceneHeading?: string): RenderPass {
  return /\bEXT\b/i.test(sceneHeading || '') ? 'clay' : 'blur';
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The frame could not be read.'));
    img.src = src;
  });

/**
 * The blur pass: grey, low contrast and heavily blurred, so only the camera, the shapes and the
 * poses survive. Blurred by drawing at 1/6 size and scaling back up, which every browser does the
 * same way (canvas filters are not everywhere). Matches the hand-made pass that tested best.
 */
export async function makeBlurPass(frameDataUrl: string): Promise<string> {
  const img = await loadImage(frameDataUrl);
  const small = document.createElement('canvas');
  small.width = 320;
  small.height = 180;
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(img, 0, 0, small.width, small.height);
  const data = sctx.getImageData(0, 0, small.width, small.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const v = (y - 128) * 0.8 + 128;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  sctx.putImageData(data, 0, 0);

  const out = document.createElement('canvas');
  out.width = 1920;
  out.height = 1080;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.9);
}

/**
 * The clay pass: grey, smoothed and flattened into eight tones, so every edge and window the
 * textures draw survives as a flat shape while colour and CG surface detail are gone. Made from
 * the textured frame, not by re-rendering the models: scanned and generated sets keep most of
 * their detail in their textures, and a real grey-material render of them came out as flat
 * silhouettes with the cars lost against the road (tested on pantilt.app, 2026-09-28).
 *
 * Same steps as the hand-made pass that tested best for exteriors: greyscale, a median filter
 * (smooths texture noise but keeps edges), a light blur, posterize to 3 bits.
 */
export async function makeClayPass(frameDataUrl: string): Promise<string> {
  const img = await loadImage(frameDataUrl);
  const w = 960;
  const h = 540;
  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const ctx = work.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const src = ctx.getImageData(0, 0, w, h).data;

  const grey = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < grey.length; i += 4, p++) {
    grey[p] = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
  }

  // 5x5 median at half size is the 9x9 median of the full-size hand pass.
  const r = 2;
  const med = new Uint8ClampedArray(w * h);
  const hist = new Uint16Array(256);
  const n = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      hist.fill(0);
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
        for (let dx = -r; dx <= r; dx++) hist[grey[yy + Math.min(w - 1, Math.max(0, x + dx))]]++;
      }
      let count = 0;
      let v = 0;
      while ((count += hist[v]) <= n >> 1) v++;
      med[y * w + x] = v;
    }
  }

  const out = ctx.createImageData(w, h);
  for (let p = 0, i = 0; p < med.length; p++, i += 4) {
    const v = med[p] & 0xe0; // 3 bits: eight flat tones
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);

  const full = document.createElement('canvas');
  full.width = 1920;
  full.height = 1080;
  const fctx = full.getContext('2d')!;
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  fctx.filter = 'blur(1px)';
  fctx.drawImage(work, 0, 0, full.width, full.height);
  return full.toDataURL('image/jpeg', 0.9);
}

/**
 * Sends a take's first frame to the server for a realistic render (Gemini describes the shot,
 * Seedream 5 Pro renders it). The server answers at once with a job; this polls until it is done.
 */

export interface RenderRequest {
  projectId: string;
  /** The textured previs frame as a data URL (JPEG). Gemini reads it; Seedream sees it only in 'full'. */
  frame: string;
  /** Image 1 for Seedream: the texture-free layout pass (blur or clay). Not needed for 'full'. */
  layout?: string;
  pass: RenderPass;
  cameraPackage: CameraPackage;
  focalLength?: string;
  aperture?: string;
  iso?: string;
  lookId?: string;
  sceneHeading?: string;
  note?: string;
}

export interface RenderResult {
  url: string;
  sourceUrl: string;
  layoutUrl: string;
  pass: RenderPass;
  prompt: string;
  model: string;
  cameraPackage: CameraPackage;
  lookId?: string;
}

export type RenderStage = 'uploading' | 'describing' | 'rendering';

async function readJson(res: Response) {
  const data = await res.json().catch(() => null);
  if (!data?.success) throw new Error(data?.error || `The server answered ${res.status}.`);
  return data;
}

export async function renderFrame(req: RenderRequest, onStage: (stage: RenderStage) => void): Promise<RenderResult> {
  onStage('uploading');
  let res: Response;
  try {
    res = await fetch('/api/render-frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch {
    throw new Error('Could not reach the server.');
  }
  const { jobId } = await readJson(res);

  // Seedream takes about two minutes; a missed poll is retried rather than failing the render.
  const started = Date.now();
  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let data: any;
    try {
      data = await readJson(await fetch(`/api/render-jobs/${jobId}`));
      misses = 0;
    } catch (err: any) {
      if (++misses >= 5) throw err;
      continue;
    }
    if (data.status === 'done') return data.result as RenderResult;
    if (data.status === 'error') throw new Error(data.error || 'The render failed.');
    onStage(data.status === 'rendering' ? 'rendering' : 'describing');
    if (Date.now() - started > 10 * 60 * 1000) throw new Error('The render took longer than 10 minutes.');
  }
}
