import fs from 'node:fs';
import path from 'node:path';
import { canOpenProject } from '../lib/crew';
import { env } from '../lib/env';
import { describeFetchError } from '../lib/errors';
import { geminiKey, geminiText } from '../lib/gemini';
import { refundGeneration } from '../lib/quota';
import { backById, normalizePackage, packageShortLine, type CameraPackage } from '../../src/services/cameraPackage';
import {
  assetsDir,
  cleanAssetUrl,
  cleanCast,
  forgetOldJobs,
  jobs,
  lookParts,
  readJsonBody,
  saveAsset,
  sendJson,
  type CastEntry,
  type RenderJob,
} from './render';

/**
 * Turns a take's previs clip into a realistic clip.
 *
 *   POST /api/render-video        start a video render; answers at once with a job id (metered)
 *   GET  /api/render-jobs/<id>    the same job route as stills; a finished video is in `video`
 *
 * Method, tested 2026-10-02 on two takes of one street (five runs, see the memory note
 * `seedance-video-edit-test`): the model edits the video it is given, so the previs supplies the
 * camera, the timing and where everything is, and this shot's own RENDERED FIRST FRAME, sent as
 * image 1, supplies the look. With that frame attached the textured previs showed no CG at all;
 * flat-colour and grey versions of the clip looked the same and placed the actor worse. The first
 * frame has to be the same framing as the clip: an image from another angle pulled the camera
 * toward its own composition.
 *
 * Seedance takes ONE video (trimmed at 15 s), up to 9 images and bills input + output seconds.
 */

const SEEDANCE_MODEL = 'bytedance/seedance-2.0-fast/video-edit';
const RESOLUTIONS = ['480p', '720p', '1080p'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

const auth = () => ({ Authorization: `Bearer ${env.WAVESPEED_API_KEY}` });

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Seedance needs URLs it can fetch, and /api/assets is behind a login, so files go to WaveSpeed's own store. */
async function uploadToWaveSpeed(assetUrl: string): Promise<string> {
  const file = path.join(assetsDir(), path.basename(assetUrl));
  if (!fs.existsSync(file)) throw new Error(`A file for the render is missing on the server (${path.basename(assetUrl)}).`);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }), path.basename(file));
  let res: Response;
  try {
    res = await fetch('https://api.wavespeed.ai/api/v3/media/upload/binary', { method: 'POST', headers: auth(), body: form, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new Error(`Could not reach WaveSpeed: ${describeFetchError(err)}`);
  }
  const data: any = await res.json().catch(() => null);
  const url = data?.data?.download_url || data?.data?.url;
  if (!res.ok || !url) throw new Error(`WaveSpeed refused an upload (HTTP ${res.status}). ${data?.message || ''}`.trim());
  return url;
}

async function seedanceEdit(body: Record<string, unknown>): Promise<Buffer> {
  let submitted: any;
  try {
    const res = await fetch(`https://api.wavespeed.ai/api/v3/${SEEDANCE_MODEL}`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    submitted = await res.json().catch(() => null);
    if (!res.ok || !submitted?.data?.id) {
      throw new Error(`The video model refused the request (HTTP ${res.status}). ${submitted?.message || submitted?.error || ''}`.trim());
    }
  } catch (err: any) {
    if (err?.message?.startsWith('The video model')) throw err;
    throw new Error(`Could not reach WaveSpeed: ${describeFetchError(err)}`);
  }

  const id = submitted.data.id;
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    let data: any;
    try {
      const res = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${id}/result`, { headers: auth(), signal: AbortSignal.timeout(30_000) });
      data = ((await res.json().catch(() => null)) as any)?.data;
    } catch {
      // A dropped poll is not a failed render; ask again.
      continue;
    }
    if (data?.status === 'completed') {
      const outUrl = data.outputs?.[0];
      if (!outUrl) throw new Error('The video model finished but returned no clip.');
      const clip = await fetch(outUrl, { signal: AbortSignal.timeout(180_000) });
      if (!clip.ok) throw new Error(`Could not download the rendered clip (HTTP ${clip.status}).`);
      return Buffer.from(await clip.arrayBuffer());
    }
    if (['failed', 'cancelled', 'timeout', 'deleted'].includes(data?.status)) {
      throw new Error(`The video render ${data.status}${data.error ? `: ${data.error}` : ''}.`);
    }
    if (Date.now() - started > 20 * 60 * 1000) throw new Error('The video render took longer than 20 minutes; gave up.');
  }
}

// ---------------------------------------------------------------------------------------------
// The action, written by Gemini from the previs clip itself

const ACTION_WRITER = `You watch a short clip from the 3D previsualization of a film shot and write ONE paragraph, 40 to 90 words, for a video model that will remake the clip as real footage. Write only what MOVES and what people and vehicles DO, in the order it happens, in plain present tense: who or what, from where to where, how.

Rules:
- Say nothing about the camera, the framing, the lens or the focus: the clip itself carries them.
- Say nothing about colours, materials, light, weather or style: a reference picture carries them.
- Every single-colour, untextured human figure is a stand-in for a person. Its colour (turquoise, orange, yellow...) is only a marker: never give that colour to the person or their clothes. When the cast list names a figure, call the person by that name ("Soma walks from the pavement on the right toward the car"). Otherwise write "a man" or "a person".
- The figures move like puppets; do not describe that. Write what each person DOES the way a director would give it to an actor, with intent and natural body language in a few words (steps off the kerb and hurries across, leans in to the window, glances back over his shoulder). Never write that someone is stiff, T-posed, floating or sliding, and never list poses frame by frame.
- Vehicles: say which way they travel relative to the camera and whether they stop.
- Do not invent anything that is not in the clip. No dialogue.
Return only the paragraph.`;

async function writeAction(videoBase64: string, sceneHeading: string, note: string, castNote: string): Promise<string> {
  const text = await geminiText({
    system: ACTION_WRITER,
    parts: [
      { inlineData: { mimeType: 'video/mp4', data: videoBase64 } },
      { text: [sceneHeading && `Scene: ${sceneHeading}.`, castNote, note && `Director's note: ${note}`].filter(Boolean).join('\n') || 'Describe the action.' },
    ],
    timeoutMs: 180_000,
  });
  return text.replace(/\s+/g, ' ').trim().slice(0, 900);
}

const NEUTRAL_GRADE = 'Grade: natural, muted film colour; rich blacks that are not crushed; natural skin.';
const MONO_GRADE = 'Grade: black and white only, every object a shade of grey; rich blacks, bright glowing highlights.';

export interface VideoPromptInput {
  projectId: string;
  videoBase64: string;
  cast: CastEntry[];
  cameraPackage: CameraPackage;
  settings: { focalLength?: string; aperture?: string; iso?: string };
  lookId?: string;
  sceneHeading: string;
  note: string;
  /** A sentence per person on their path through the clip and what they were directed to do. */
  blocking: string[];
}

/** Blocking sentences are built by the browser from measurements and the actor's own direction. */
function cleanBlocking(input: any): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v: any) => String(v ?? '').replace(/[^\p{L}\p{N} .,:;'()%-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 600))
    .filter(Boolean)
    .slice(0, 8);
}

// The previs actor is a puppet: its walk is a looped cycle, its arms hang, nothing has weight. A
// video-edit model asked to keep "how they move" copied that faithfully. So the clip is trusted
// for WHERE a person is and where they go, and the model is told to act the move itself.
const PERFORMANCE = `People: the figures in the input video are crude animated stand-ins. Take from them only where each person is, where they go, which way they face and when; their body animation is a placeholder, so do not copy its poses, gait or arm movement frame by frame. Each person performs the same move as a real actor on a film set would: natural weight and balance, a real walking rhythm with heel strike and arm swing, shoulders and hips moving, the head and eyes leading a turn, hands doing something believable, clothes and hair moving with the body, small human hesitations. Feet stay planted on the ground with no sliding.`;

/**
 * The prompt for one clip, in the order that tested well: what the input clip is for, what image 1
 * is, who each stand-in is, the action, then the camera package and the grade, then the short
 * guard. No camera moves in words: the clip carries them, and words there only fight it.
 */
export async function buildVideoPrompt(input: VideoPromptInput): Promise<{ prompt: string; lookUsed: boolean }> {
  const monochrome = backById(input.cameraPackage.backId)?.id === 'doublex';
  const look = input.lookId && !monochrome ? await lookParts(input.projectId, input.lookId) : { grade: null, imageDataUrl: null };
  const grade = monochrome ? MONO_GRADE : look.grade || NEUTRAL_GRADE;

  // Image 1 is the first frame; the sheets follow in the order they are sent.
  const castLines = input.cast.map(
    (m, i) =>
      `The ${m.colorName} figure is a stand-in for ${m.name} in @Image ${i + 2}: the same face, hair, build and clothes. Its colour is only a marker, never clothing. ${m.name} follows the figure's position, path and timing. Use @Image ${i + 2} only for who they are, not for its lighting, background or pose.`
  );
  const castNote = input.cast.length
    ? `Cast: ${input.cast.map((m) => `the ${m.colorName} figure is ${m.name}`).join('; ')}.`
    : '';

  const action = await writeAction(input.videoBase64, input.sceneHeading, input.note, castNote);

  const prompt = [
    'The input video is a rough 3D previs layout of this shot. Keep exactly its camera position, lens, framing and camera movement, its timing, where every building and object is, and how every vehicle moves. Do not keep its surfaces, colours, lighting or render quality: rebuild everything as real, photographed materials.',
    '@Image 1 is this same shot already photographed for real. The opening frame of the result looks like @Image 1, and the whole clip keeps its location, materials, colours, weather, light, colour grade and film grain.',
    castLines.join(' '),
    input.blocking.length || input.cast.length ? PERFORMANCE : null,
    input.blocking.length ? `Blocking: ${input.blocking.join(' ')}` : null,
    `Action: ${action}`,
    packageShortLine(input.cameraPackage, input.settings),
    grade,
    input.note && `Director's note: ${input.note}`,
    'A candid live-action film shot, one continuous take. No cuts, no text, no subtitles, no extra people, no CG finish, no stiff, robotic or mannequin-like movement.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { prompt, lookUsed: !!look.grade };
}

async function runVideoJob(
  job: RenderJob,
  input: VideoPromptInput & { sourceUrl: string; firstFrameUrl: string; resolution: Resolution; sound: boolean }
) {
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    const { prompt, lookUsed } = await buildVideoPrompt(input);
    console.log(`[API render-video] ${job.id} prompt written in ${secs()}s`);

    job.status = 'rendering';
    const [video, firstFrame, ...sheets] = await Promise.all(
      [input.sourceUrl, input.firstFrameUrl, ...input.cast.map((m) => m.sheetUrl)].map(uploadToWaveSpeed)
    );
    const clip = await seedanceEdit({
      prompt,
      video,
      reference_images: [firstFrame, ...sheets],
      aspect_ratio: '16:9',
      resolution: input.resolution,
      generate_audio: input.sound,
    });
    const url = saveAsset('render_video', 'mp4', clip);

    job.video = {
      url,
      sourceUrl: input.sourceUrl,
      firstFrameUrl: input.firstFrameUrl,
      resolution: input.resolution,
      prompt,
      model: SEEDANCE_MODEL,
      cameraPackage: input.cameraPackage,
      lookId: lookUsed ? input.lookId : undefined,
    };
    job.status = 'done';
    console.log(`[API render-video] ${job.id} done in ${secs()}s -> ${url}`);
  } catch (err: any) {
    job.status = 'error';
    job.error = err?.message || String(err);
    console.error(`[API render-video] ${job.id} failed after ${secs()}s:`, job.error);
    refundGeneration(job.owner).catch(() => {});
  }
}

/** Handles POST /api/render-video. Returns true when it answered. */
export async function handleRenderVideoApi(req: any, res: any): Promise<boolean> {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== '/api/render-video' || req.method !== 'POST') return false;
  const user = req.auraUser;

  try {
    // 503 when the server itself cannot render, so the metered slot is handed back.
    if (!env.WAVESPEED_API_KEY) {
      sendJson(res, 503, { success: false, error: 'The server has no WaveSpeed key, so it cannot render video yet.' });
      return true;
    }
    if (!geminiKey()) {
      sendJson(res, 503, { success: false, error: 'The server has no Gemini key, so it cannot describe the shot.' });
      return true;
    }

    // A 15 s clip at 720p is a few megabytes; base64 adds a third.
    const body = await readJsonBody(req, 64 * 1024 * 1024);
    const projectId = String(body.projectId || '');
    if (!(await canOpenProject(user._id, projectId))) {
      sendJson(res, 404, { success: false, error: 'No such project.' });
      return true;
    }

    const match = /^data:video\/mp4;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.video || ''));
    if (!match) {
      sendJson(res, 400, { success: false, error: 'The previs clip did not arrive as an MP4.' });
      return true;
    }
    const firstFrameUrl = cleanAssetUrl(body.firstFrameUrl);
    if (!firstFrameUrl || !fs.existsSync(path.join(assetsDir(), path.basename(firstFrameUrl)))) {
      sendJson(res, 400, { success: false, error: 'Render the first frame of this take before rendering its video.' });
      return true;
    }
    const videoBase64 = match[1];
    const sourceUrl = saveAsset('render_video_src', 'mp4', Buffer.from(videoBase64, 'base64'));
    const resolution: Resolution = RESOLUTIONS.includes(body.resolution) ? body.resolution : '480p';

    forgetOldJobs();
    const job: RenderJob = {
      id: `vj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: user._id.toHexString(),
      owner: user._id,
      status: 'describing',
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);

    const cameraPackage = normalizePackage(body.cameraPackage);
    const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
    console.log(`[API render-video] ${job.id} for ${user.email}: ${resolution}, ${cameraPackage.cameraId} / ${cameraPackage.lensId} / ${cameraPackage.backId}`);

    runVideoJob(job, {
      projectId,
      videoBase64,
      sourceUrl,
      firstFrameUrl,
      resolution,
      sound: body.sound !== false,
      // Seedance takes 9 images: the first frame and up to 8 people.
      cast: cleanCast(body.cast),
      cameraPackage,
      settings: { focalLength: clip(body.focalLength, 12), aperture: clip(body.aperture, 12), iso: clip(body.iso, 8) },
      lookId: body.lookId ? clip(body.lookId, 40) : undefined,
      sceneHeading: clip(body.sceneHeading, 200),
      note: clip(body.note, 1000),
      blocking: cleanBlocking(body.blocking),
    });

    sendJson(res, 200, { success: true, jobId: job.id });
    return true;
  } catch (err: any) {
    console.error('[API render-video]', err?.message || err);
    sendJson(res, 400, { success: false, error: err?.message || 'Could not start the video render.' });
    return true;
  }
}
