import type { CameraPackage } from './cameraPackage';

/**
 * Sends a take's first frame to the server for a realistic render (Gemini describes the shot,
 * Seedream 5 Pro renders it). The server answers at once with a job; this polls until it is done.
 */

export interface RenderRequest {
  projectId: string;
  /** The previs frame as a data URL (JPEG). */
  frame: string;
  cameraPackage: CameraPackage;
  focalLength?: string;
  aperture?: string;
  iso?: string;
  lookId?: string;
  sceneHeading?: string;
  note?: string;
  /** 'layout' (default): previs fixes camera, geometry, composition only. 'exact': copy it closely. */
  fidelity?: 'layout' | 'exact';
}

export interface RenderResult {
  url: string;
  sourceUrl: string;
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
