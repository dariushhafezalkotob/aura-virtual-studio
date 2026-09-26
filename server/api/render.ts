import fs from 'node:fs';
import type { ObjectId } from 'mongodb';
import path from 'node:path';
import { canOpenProject } from '../lib/crew';
import { env } from '../lib/env';
import { describeFetchError } from '../lib/errors';
import { geminiKey, geminiText } from '../lib/gemini';
import { getLook } from '../lib/looks';
import { refundGeneration } from '../lib/quota';
import { backById, normalizePackage, packagePromptSections } from '../../src/services/cameraPackage';

/**
 * Turns a take's first frame into a realistic film frame.
 *
 *   POST /api/render-frame        start a render; answers at once with a job id (metered)
 *   GET  /api/render-jobs/<id>    how that job is doing, and its result when done
 *
 * A render takes about two minutes (Seedream alone is ~2 min), which is too long to hold one HTTP
 * request open from a phone or over a VPN, hence the job. Jobs live in memory: a server restart
 * loses the ones in flight, and their images, if any, are still in data/assets.
 *
 * The prompt is built in order: the shot (Gemini describes this exact frame), camera, lens, film
 * back (the take's camera package), lighting (Gemini), grade (a Look from the library, or
 * neutral), the director's note, and the clean-frame rules.
 */

const SEEDREAM_EDIT = 'https://api.wavespeed.ai/api/v3/bytedance/seedream-v5.0-pro/edit';
const SEEDREAM_MODEL = 'bytedance/seedream-v5.0-pro/edit';
// 1k and 1.5k cost the same ($0.045); 2k is double.
const RENDER_RESOLUTION = '1.5k';

type JobStatus = 'describing' | 'rendering' | 'done' | 'error';

interface RenderJob {
  id: string;
  userId: string;
  /** The account to hand the generation back to if the render fails. */
  owner: ObjectId;
  status: JobStatus;
  createdAt: number;
  error?: string;
  result?: { url: string; sourceUrl: string; prompt: string; model: string; cameraPackage: any; lookId?: string };
}

const jobs = new Map<string, RenderJob>();

function forgetOldJobs() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}

function readJsonBody(req: any, limit: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) reject(new Error('The frame is too large.'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function assetsDir(): string {
  const dir = path.join(process.cwd(), 'data', 'assets');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveAsset(prefix: string, ext: string, buf: Buffer): string {
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  fs.writeFileSync(path.join(assetsDir(), filename), buf);
  return `/api/assets/${filename}`;
}

// ---------------------------------------------------------------------------------------------
// The shot and its light, written by Gemini from the frame itself

// 'layout': the previs fixes camera, geometry and composition only; the model invents every
// surface and detail. 'exact': the previs is copied closely (the first version). Users found
// 'exact' carried the previs's CG detail into the render and held realism back (2026-09-26).
export type RenderFidelity = 'layout' | 'exact';

const LAYOUT_WRITER = `You look at one frame from the 3D previsualization of a film and write two parts of a prompt for an image model. The previs is only a LAYOUT GUIDE: its CG textures, low detail and flat surfaces must NOT be copied. The model will photograph the scene from scratch, freely inventing rich, real detail, while keeping the shot's layout.

"keep": one paragraph. Start with: "The input image is a 3D previs layout, not a picture to copy. Use it only for the camera angle, the geometry of the set and the composition, then photograph the scene for real, inventing all surface detail freely." Then state precisely what the layout fixes: the camera position, height, angle and lens framing; the shape and placement of the space (walls, openings, floor, ceiling); where each large object and piece of furniture stands; each person's place in the frame, pose and eyeline. Then, object by object, say what each thing is MADE OF and where it is (e.g. "the long counter on the right is dark, worn hardwood with a brass foot rail"; "the back wall is exposed brick"), reading the materials from the previs colours and shapes. Say that textures, wear, small props, dressing and every fine detail should be generated anew and richly, as on a real, lived-in set, and should not follow the previs surfaces. Untextured or single-colour figures and mannequins are stand-ins: replace each with a real person in the same pose, and describe a believable person for each (age range, build, hair, wardrobe that suits the scene), unless the director's note says who they are. End with: "Do not change the camera angle, the layout or where anyone stands."

"lighting": one paragraph that starts with "Lighting:" and describes the light as a cinematographer would: which sources light the scene (lamps, windows, sun, screens), direction, hardness, colour temperature, time of day and contrast. Stay true to the frame and the scene heading.

Rules: never add or remove large objects or people; say nothing about camera bodies, lenses, film stock or grading, which are written separately; plain, direct sentences with no hype words.`;

const SHOT_WRITER = `You look at one frame from the 3D previsualization of a film and write two parts of a prompt for an image-editing model. That model will turn this exact frame into a real frame photographed on set, so your words must pin the shot down precisely.

"keep": one paragraph. Start with: "The input image is a frame from the 3D previsualization of a film. Recreate it as a real frame photographed on set for the finished movie." Then say exactly what must not change: the camera position, height, angle and framing; every person's place in the frame (left, centre, right; foreground or background), their pose, where they look and what their hands are doing; the set, furniture and props and where each one is; every visible light source. Name things by what they are and where they are in the frame. Then write: "Do not move the camera and do not move anyone." Untextured or single-colour figures and mannequins are stand-ins for actors: tell the model to replace each with a real person in the same pose, and describe a believable person for each (age range, build, hair, wardrobe that suits the scene), unless the director's note says who they are. Finish by saying the CG surfaces become real materials, naming the materials you can see (wood, leather, brass, glass, concrete...).

"lighting": one paragraph that starts with "Lighting:" and describes the light in this frame the way a cinematographer would: which sources light the scene (lamps, windows, sun, screens), their direction, hardness and colour temperature, the time of day, and how contrasty the frame is. Stay true to the frame and to the scene heading.

Rules: describe only what is in the frame, never add objects or people; say nothing about camera bodies, lenses, film stock or colour grading, which are written separately; plain, direct sentences with no hype words.`;

const SHOT_SCHEMA = {
  type: 'OBJECT',
  properties: { keep: { type: 'STRING' }, lighting: { type: 'STRING' } },
  required: ['keep', 'lighting'],
};

async function describeShot(frameBase64: string, mimeType: string, sceneHeading: string, note: string, fidelity: RenderFidelity) {
  const context = [
    sceneHeading && `Scene heading: ${sceneHeading}`,
    note && `Director's note: ${note}`,
  ].filter(Boolean).join('\n');
  const parts: any[] = [{ inlineData: { mimeType, data: frameBase64 } }];
  if (context) parts.push({ text: context });
  // From a network behind a VPN one call measured 12-37s (2026-09-26); from the server it is a few
  // seconds. The limit only has to stop a hung call, not a slow one.
  const raw = await geminiText({ system: fidelity === 'exact' ? SHOT_WRITER : LAYOUT_WRITER, parts, json: { schema: SHOT_SCHEMA }, timeoutMs: 180_000 });
  const parsed = JSON.parse(raw);
  const lighting = String(parsed.lighting || '').trim();
  return {
    keep: String(parsed.keep || '').trim(),
    lighting: /^lighting:/i.test(lighting) ? lighting : `Lighting: ${lighting}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The grade

/** The grade paragraph from a saved Look: its "Color grade:" section, or one built from its fields. */
async function gradeFromLook(projectId: string, lookId: string): Promise<string | null> {
  const look = await getLook(projectId, lookId);
  if (!look) return null;
  const idx = look.lookPrompt.search(/colou?r grade:/i);
  if (idx >= 0) return look.lookPrompt.slice(idx).trim();
  const bits = [
    look.colorNotes && `Color grade: ${look.colorNotes}.`,
    look.palette.length > 0 && `Use this palette, darkest to lightest: ${look.palette.join(', ')}.`,
  ].filter(Boolean);
  return bits.length ? bits.join(' ') : null;
}

const NEUTRAL_GRADE = 'Grade: a natural film grade that shows the camera, lens and film exactly as they are, with no added stylised colour.';
const MONO_GRADE = 'Grade: black and white only. Keep the frame fully monochrome whatever the lights and props are.';
const CLEAN = 'Deliver one clean photograph filling the whole frame: no text, no captions, no letterbox bars, no film borders, no watermark.';

// ---------------------------------------------------------------------------------------------
// Seedream via WaveSpeed

async function seedreamEdit(prompt: string, frameDataUrl: string): Promise<Buffer> {
  const key = env.WAVESPEED_API_KEY;
  const auth = { Authorization: `Bearer ${key}` };

  let submitted: any;
  try {
    const res = await fetch(SEEDREAM_EDIT, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, images: [frameDataUrl], aspect_ratio: '16:9', resolution: RENDER_RESOLUTION, output_format: 'jpeg' }),
      signal: AbortSignal.timeout(60_000),
    });
    submitted = await res.json().catch(() => null);
    if (!res.ok || !submitted?.data?.id) {
      throw new Error(`Seedream refused the request (HTTP ${res.status}). ${submitted?.message || submitted?.error || ''}`.trim());
    }
  } catch (err: any) {
    if (err?.message?.startsWith('Seedream')) throw err;
    throw new Error(`Could not reach WaveSpeed: ${describeFetchError(err)}`);
  }

  const id = submitted.data.id;
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let data: any;
    try {
      const res = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${id}/result`, { headers: auth, signal: AbortSignal.timeout(30_000) });
      data = ((await res.json().catch(() => null)) as any)?.data;
    } catch {
      // A dropped poll is not a failed render; ask again.
      continue;
    }
    if (data?.status === 'completed') {
      const outUrl = data.outputs?.[0];
      if (!outUrl) throw new Error('Seedream finished but returned no image.');
      const img = await fetch(outUrl, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new Error(`Could not download the rendered frame (HTTP ${img.status}).`);
      return Buffer.from(await img.arrayBuffer());
    }
    if (['failed', 'cancelled', 'timeout', 'deleted'].includes(data?.status)) {
      throw new Error(`Seedream ${data.status}${data.error ? `: ${data.error}` : ''}.`);
    }
    if (Date.now() - started > 8 * 60 * 1000) throw new Error('Seedream took longer than 8 minutes; gave up.');
  }
}

// ---------------------------------------------------------------------------------------------

export interface RenderPromptInput {
  fidelity: RenderFidelity;
  projectId: string;
  frameBase64: string;
  mimeType: string;
  cameraPackage: ReturnType<typeof normalizePackage>;
  settings: { focalLength?: string; aperture?: string; iso?: string };
  lookId?: string;
  sceneHeading: string;
  note: string;
}

/** The full prompt for one frame. Exported so it can be checked without paying for a render. */
export async function buildRenderPrompt(input: RenderPromptInput): Promise<{ prompt: string; lookUsed: boolean }> {
  const shot = await describeShot(input.frameBase64, input.mimeType, input.sceneHeading, input.note, input.fidelity);

  const monochrome = backById(input.cameraPackage.backId)?.id === 'doublex';
  const lookGrade = input.lookId && !monochrome ? await gradeFromLook(input.projectId, input.lookId) : null;
  const grade = monochrome ? MONO_GRADE : lookGrade || NEUTRAL_GRADE;

  const prompt = [
    shot.keep,
    ...packagePromptSections(input.cameraPackage, input.settings),
    shot.lighting,
    grade,
    input.note && `Director's note: ${input.note}`,
    CLEAN,
  ].filter(Boolean).join('\n\n');
  return { prompt, lookUsed: !!lookGrade };
}

async function runJob(job: RenderJob, input: RenderPromptInput & { frameDataUrl: string; sourceUrl: string }) {
  const started = Date.now();
  try {
    const { prompt, lookUsed } = await buildRenderPrompt(input);
    console.log(`[API render-frame] ${job.id} prompt written in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    job.status = 'rendering';
    const image = await seedreamEdit(prompt, input.frameDataUrl);
    const url = saveAsset('render', 'jpg', image);

    job.result = { url, sourceUrl: input.sourceUrl, prompt, model: SEEDREAM_MODEL, cameraPackage: input.cameraPackage, lookId: lookUsed ? input.lookId : undefined };
    job.status = 'done';
    console.log(`[API render-frame] ${job.id} done in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${url}`);
  } catch (err: any) {
    job.status = 'error';
    job.error = err?.message || String(err);
    console.error(`[API render-frame] ${job.id} failed after ${((Date.now() - started) / 1000).toFixed(1)}s:`, job.error);
    // The generation was counted when the job started; a failed one hands the slot back.
    refundGeneration(job.owner).catch(() => {});
  }
}

/** Handles /api/render-frame and /api/render-jobs/<id>. Returns true when it answered. */
export async function handleRenderApi(req: any, res: any): Promise<boolean> {
  const urlPath = (req.url || '').split('?')[0];
  const user = req.auraUser;

  const jobMatch = /^\/api\/render-jobs\/([A-Za-z0-9_]+)$/.exec(urlPath);
  if (jobMatch && req.method === 'GET') {
    const job = jobs.get(jobMatch[1]);
    if (!job || job.userId !== user._id.toHexString()) {
      sendJson(res, 404, { success: false, error: 'That render is not known to the server any more.' });
    } else {
      sendJson(res, 200, { success: true, status: job.status, error: job.error, result: job.result });
    }
    return true;
  }

  if (urlPath !== '/api/render-frame' || req.method !== 'POST') return false;

  try {
    // 503 when the server itself cannot render, so the metered slot is handed back.
    if (!env.WAVESPEED_API_KEY) {
      sendJson(res, 503, { success: false, error: 'The server has no WaveSpeed key, so it cannot render with Seedream yet.' });
      return true;
    }
    if (!geminiKey()) {
      sendJson(res, 503, { success: false, error: 'The server has no Gemini key, so it cannot describe the shot.' });
      return true;
    }

    const body = await readJsonBody(req, 16 * 1024 * 1024);
    const projectId = String(body.projectId || '');
    if (!(await canOpenProject(user._id, projectId))) {
      sendJson(res, 404, { success: false, error: 'No such project.' });
      return true;
    }

    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.frame || ''));
    if (!match) {
      sendJson(res, 400, { success: false, error: 'The first frame did not arrive as an image.' });
      return true;
    }
    const [, mimeType, frameBase64] = match;
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const sourceUrl = saveAsset('render_src', ext, Buffer.from(frameBase64, 'base64'));

    forgetOldJobs();
    const job: RenderJob = {
      id: `rj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: user._id.toHexString(),
      owner: user._id,
      status: 'describing',
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);

    const cameraPackage = normalizePackage(body.cameraPackage);
    const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
    console.log(`[API render-frame] ${job.id} for ${user.email}: ${cameraPackage.cameraId} / ${cameraPackage.lensId} / ${cameraPackage.backId}`);

    runJob(job, {
      projectId,
      frameDataUrl: body.frame,
      frameBase64,
      mimeType,
      sourceUrl,
      cameraPackage,
      settings: { focalLength: clip(body.focalLength, 12), aperture: clip(body.aperture, 12), iso: clip(body.iso, 8) },
      lookId: body.lookId ? clip(body.lookId, 40) : undefined,
      sceneHeading: clip(body.sceneHeading, 200),
      note: clip(body.note, 1000),
      fidelity: body.fidelity === 'exact' ? 'exact' : 'layout',
    });

    sendJson(res, 200, { success: true, jobId: job.id });
    return true;
  } catch (err: any) {
    console.error('[API render-frame]', err?.message || err);
    sendJson(res, 400, { success: false, error: err?.message || 'Could not start the render.' });
    return true;
  }
}
