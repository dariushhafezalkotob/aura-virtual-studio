import fs from 'node:fs';
import type { ObjectId } from 'mongodb';
import path from 'node:path';
import { canOpenProject } from '../lib/crew';
import { env } from '../lib/env';
import { describeFetchError } from '../lib/errors';
import { geminiKey, geminiText } from '../lib/gemini';
import { getLook } from '../lib/looks';
import { refundGeneration } from '../lib/quota';
import { backById, normalizePackage, packagePromptSections, packageShortLine } from '../../src/services/cameraPackage';

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
  result?: { url: string; sourceUrl: string; layoutUrl: string; pass: RenderPass; prompt: string; model: string; cameraPackage: any; lookId?: string };
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

// What image 1 (the one Seedream sees) is. Found by hand-testing in Seedream (2026-09-26..28):
// an edit model copies whatever the input image shows, so a textured previs leaks its CG textures,
// colours and flat light however the prompt is worded. A texture-free layout pass fixes that:
// 'blur' (grey + heavily blurred) suits interiors, 'clay' (every model grey matte) suits exteriors,
// whose hard lines blur melts. 'full' sends the textured frame and copies it closely.
export type RenderPass = 'blur' | 'clay' | 'full';

const TEMPLATE_WRITER = `You read one frame from the 3D previsualization of a film and write three short lines for a fixed image-generation prompt. The image model will NOT see this frame: it only gets a grey, texture-free layout of the same shot. So every colour and material must come from your words, and nothing else.

"light": one sentence, at most 25 words: the time of day and the sources that light the scene, e.g. "Night, lit only by small warm lamps; everything else falls into deep shadow." Use the scene heading.

"place": at most 70 words. Start with what the place is ("An old pub at night:", "A New York street:"). Then its main parts, each with its material AND colour, tied to where it is in the frame ("the townhouses on the left are brownstone with black iron railings; the corner building in the centre is red brick with black fire escapes"). Read the colours from the frame; they are needed. Add age and wear (old, scuffed, stained, cracked). If you see holes in the models, floating blobs, grid or guide lines, end with one short sentence starting "Ignore" that names them as errors.

"people": at most 40 words per person. Every untextured or single-colour figure is a stand-in: describe a believable real person (age, hair, wardrobe that suits the scene, with colours) who is exactly where the figure is, in exactly its pose, doing what it is doing ("sits exactly where the figure sits, hands on his knees, looking away to the left"; "walks along the far sidewalk"). The figure's own colour (turquoise, yellow, purple...) is only a marker in the previs: never give the person, their clothes or anything else that colour. If a seated figure has nothing under it, give it a chair that suits the place. Follow the director's note when it names who someone is. Use an empty string when there are no figures.

Rules: nothing about camera, lens, film stock, grading or mood beyond the light sentence; never add or remove large objects; plain words, no hype.`;

const TEMPLATE_SCHEMA = {
  type: 'OBJECT',
  properties: { light: { type: 'STRING' }, place: { type: 'STRING' }, people: { type: 'STRING' } },
  required: ['light', 'place', 'people'],
};

const SHOT_WRITER = `You look at one frame from the 3D previsualization of a film and write two parts of a prompt for an image-editing model. That model will turn this exact frame into a real frame photographed on set, so your words must pin the shot down precisely.

"keep": one paragraph. Start with: "The input image is a frame from the 3D previsualization of a film. Recreate it as a real frame photographed on set for the finished movie." Then say exactly what must not change: the camera position, height, angle and framing; every person's place in the frame (left, centre, right; foreground or background), their pose, where they look and what their hands are doing; the set, furniture and props and where each one is; every visible light source. Name things by what they are and where they are in the frame. Then write: "Do not move the camera and do not move anyone." Untextured or single-colour figures and mannequins are stand-ins for actors: tell the model to replace each with a real person in the same pose, and describe a believable person for each (age range, build, hair, wardrobe that suits the scene), unless the director's note says who they are. Finish by saying the CG surfaces become real materials, naming the materials you can see (wood, leather, brass, glass, concrete...).

"lighting": one paragraph that starts with "Lighting:" and describes the light in this frame the way a cinematographer would: which sources light the scene (lamps, windows, sun, screens), their direction, hardness and colour temperature, the time of day, and how contrasty the frame is. Stay true to the frame and to the scene heading.

Rules: describe only what is in the frame, never add objects or people; say nothing about camera bodies, lenses, film stock or colour grading, which are written separately; plain, direct sentences with no hype words.`;

const SHOT_SCHEMA = {
  type: 'OBJECT',
  properties: { keep: { type: 'STRING' }, lighting: { type: 'STRING' } },
  required: ['keep', 'lighting'],
};

function frameParts(frameBase64: string, mimeType: string, sceneHeading: string, note: string): any[] {
  const context = [
    sceneHeading && `Scene heading: ${sceneHeading}`,
    note && `Director's note: ${note}`,
  ].filter(Boolean).join('\n');
  const parts: any[] = [{ inlineData: { mimeType, data: frameBase64 } }];
  if (context) parts.push({ text: context });
  return parts;
}

// From a network behind a VPN one call measured 12-37s (2026-09-26); from the server it is a few
// seconds. The limit only has to stop a hung call, not a slow one.
async function writeTemplateLines(frameBase64: string, mimeType: string, sceneHeading: string, note: string) {
  const raw = await geminiText({ system: TEMPLATE_WRITER, parts: frameParts(frameBase64, mimeType, sceneHeading, note), json: { schema: TEMPLATE_SCHEMA }, timeoutMs: 180_000 });
  const parsed = JSON.parse(raw);
  return {
    light: String(parsed.light || '').trim(),
    place: String(parsed.place || '').trim(),
    people: String(parsed.people || '').trim(),
  };
}

async function describeShot(frameBase64: string, mimeType: string, sceneHeading: string, note: string) {
  const raw = await geminiText({ system: SHOT_WRITER, parts: frameParts(frameBase64, mimeType, sceneHeading, note), json: { schema: SHOT_SCHEMA }, timeoutMs: 180_000 });
  const parsed = JSON.parse(raw);
  const lighting = String(parsed.lighting || '').trim();
  return {
    keep: String(parsed.keep || '').trim(),
    lighting: /^lighting:/i.test(lighting) ? lighting : `Lighting: ${lighting}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The grade

/**
 * What a saved Look contributes: its grade paragraph (newer looks hold only that; older ones hold
 * a long text whose "Color grade:" part is taken) and its reference still, sent as image 2.
 */
async function lookParts(projectId: string, lookId: string): Promise<{ grade: string | null; imageDataUrl: string | null }> {
  const look = await getLook(projectId, lookId);
  if (!look) return { grade: null, imageDataUrl: null };

  const text = look.lookPrompt.trim();
  const idx = text.search(/(colou?r )?grade:/i);
  let grade: string | null = idx >= 0 ? text.slice(idx).trim() : null;
  if (grade && !/^grade:/i.test(grade)) grade = grade.replace(/^colou?r grade:/i, 'Grade:');
  if (!grade) {
    const bits = [look.colorNotes, look.palette.length > 0 && `palette, darkest to lightest: ${look.palette.join(', ')}`].filter(Boolean);
    grade = bits.length ? `Grade: ${bits.join('; ')}.` : null;
  }

  let imageDataUrl: string | null = null;
  if (look.referenceUrl) {
    const file = path.join(assetsDir(), path.basename(look.referenceUrl.replace('/api/assets/', '')));
    if (fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      imageDataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    }
  }
  return { grade, imageDataUrl };
}

const NEUTRAL_GRADE = 'Grade: natural, muted film colour; rich blacks that are not crushed; natural skin.';
const MONO_GRADE = 'Grade: black and white only, every object a shade of grey; rich blacks, bright glowing highlights.';
const CLEAN = 'One clean photograph filling the frame, no text, no borders, no watermark.';
const LOOK_IMAGE_LINE = 'Image 2 is the look: match its light, darkness, colour grade, haze and grain, but take none of its content or layout.';
const IMAGE_ROLE: Record<Exclude<RenderPass, 'full'>, string> = {
  blur: 'Image 1 is a blurred grey layout sketch of the shot',
  clay: 'Image 1 is a grey clay model of the shot',
};

// ---------------------------------------------------------------------------------------------
// Seedream via WaveSpeed

async function seedreamEdit(prompt: string, images: string[]): Promise<Buffer> {
  const key = env.WAVESPEED_API_KEY;
  const auth = { Authorization: `Bearer ${key}` };

  let submitted: any;
  try {
    const res = await fetch(SEEDREAM_EDIT, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, images, aspect_ratio: '16:9', resolution: RENDER_RESOLUTION, output_format: 'jpeg' }),
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
  pass: RenderPass;
  projectId: string;
  /** The textured previs frame: Gemini reads it; Seedream only sees it in 'full' mode. */
  frameBase64: string;
  mimeType: string;
  cameraPackage: ReturnType<typeof normalizePackage>;
  settings: { focalLength?: string; aperture?: string; iso?: string };
  lookId?: string;
  sceneHeading: string;
  note: string;
}

/**
 * The full prompt for one frame, and the reference images that go with it after image 1.
 * Exported so it can be checked without paying for a render.
 *
 * Layout passes use the short fixed template (~150 words): what each image is for, one film-still
 * line with the light, the place with colours tied to positions, the people, the camera package
 * in one sentence, the grade, the director's note, the clean-frame rule.
 */
export async function buildRenderPrompt(input: RenderPromptInput): Promise<{ prompt: string; lookUsed: boolean; extraImages: string[] }> {
  const monochrome = backById(input.cameraPackage.backId)?.id === 'doublex';
  // A colour look image would fight a black-and-white stock, so it is left out there.
  const look = input.lookId && !monochrome ? await lookParts(input.projectId, input.lookId) : { grade: null, imageDataUrl: null };
  const grade = monochrome ? MONO_GRADE : look.grade || NEUTRAL_GRADE;
  const extraImages = look.imageDataUrl ? [look.imageDataUrl] : [];

  if (input.pass === 'full') {
    const shot = await describeShot(input.frameBase64, input.mimeType, input.sceneHeading, input.note);
    const prompt = [
      shot.keep,
      extraImages.length ? LOOK_IMAGE_LINE : null,
      ...packagePromptSections(input.cameraPackage, input.settings),
      shot.lighting,
      grade,
      input.note && `Director's note: ${input.note}`,
      CLEAN,
    ].filter(Boolean).join('\n\n');
    return { prompt, lookUsed: !!look.grade, extraImages };
  }

  const lines = await writeTemplateLines(input.frameBase64, input.mimeType, input.sceneHeading, input.note);
  const prompt = [
    [
      `${IMAGE_ROLE[input.pass]}: keep its camera angle, framing, the geometry of the space, where every object stands and every person's position and pose; it has no colour, texture or light, so invent them.`,
      extraImages.length ? LOOK_IMAGE_LINE : null,
    ].filter(Boolean).join(' '),
    `A candid film still from a feature film, shot on location, not a render. ${lines.light}`,
    lines.place,
    lines.people,
    packageShortLine(input.cameraPackage, input.settings),
    grade,
    input.note && `Director's note: ${input.note}`,
    CLEAN,
  ].filter(Boolean).join('\n\n');
  return { prompt, lookUsed: !!look.grade, extraImages };
}

async function runJob(job: RenderJob, input: RenderPromptInput & { layoutDataUrl: string; sourceUrl: string; layoutUrl: string }) {
  const started = Date.now();
  try {
    const { prompt, lookUsed, extraImages } = await buildRenderPrompt(input);
    console.log(`[API render-frame] ${job.id} prompt written in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    job.status = 'rendering';
    const image = await seedreamEdit(prompt, [input.layoutDataUrl, ...extraImages]);
    const url = saveAsset('render', 'jpg', image);

    job.result = { url, sourceUrl: input.sourceUrl, layoutUrl: input.layoutUrl, pass: input.pass, prompt, model: SEEDREAM_MODEL, cameraPackage: input.cameraPackage, lookId: lookUsed ? input.lookId : undefined };
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

    const body = await readJsonBody(req, 24 * 1024 * 1024);
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
    const extOf = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');
    const sourceUrl = saveAsset('render_src', extOf(mimeType), Buffer.from(frameBase64, 'base64'));

    // Image 1 for Seedream: the texture-free layout pass, or the frame itself in 'full' mode.
    const pass: RenderPass = body.pass === 'clay' || body.pass === 'full' ? body.pass : 'blur';
    let layoutDataUrl = String(body.frame);
    let layoutUrl = sourceUrl;
    if (pass !== 'full') {
      const layout = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.layout || ''));
      if (!layout) {
        sendJson(res, 400, { success: false, error: 'The layout pass did not arrive as an image.' });
        return true;
      }
      layoutDataUrl = String(body.layout);
      layoutUrl = saveAsset(`render_${pass}`, extOf(layout[1]), Buffer.from(layout[2], 'base64'));
    }

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
    console.log(`[API render-frame] ${job.id} for ${user.email}: ${pass} pass, ${cameraPackage.cameraId} / ${cameraPackage.lensId} / ${cameraPackage.backId}`);

    runJob(job, {
      projectId,
      pass,
      layoutDataUrl,
      layoutUrl,
      frameBase64,
      mimeType,
      sourceUrl,
      cameraPackage,
      settings: { focalLength: clip(body.focalLength, 12), aperture: clip(body.aperture, 12), iso: clip(body.iso, 8) },
      lookId: body.lookId ? clip(body.lookId, 40) : undefined,
      sceneHeading: clip(body.sceneHeading, 200),
      note: clip(body.note, 1000),
    });

    sendJson(res, 200, { success: true, jobId: job.id });
    return true;
  } catch (err: any) {
    console.error('[API render-frame]', err?.message || err);
    sendJson(res, 400, { success: false, error: err?.message || 'Could not start the render.' });
    return true;
  }
}
