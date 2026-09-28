import type { CameraPackage } from './cameraPackage';

/**
 * What Seedream gets as image 1. An edit model copies whatever that image shows, so the textured
 * previs leaks its CG look; a texture-free pass does not. Blur suits interiors, clay exteriors.
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
