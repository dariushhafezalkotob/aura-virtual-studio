import { Client } from '@gradio/client';
import { getHfToken } from './env';
import { resolveMediaUrl } from './media';
import type { ReportProgress } from './modelJobs';

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
 * Where the Space's own progress lands on the 0-100 bar. The Space reports tqdm bars by name
 * (captured 2026-10-01): "Sampling sparse structure", "Sampling shape SLat", "Sampling texture
 * SLat" and "Rendering" during /image_to_3d, then "Extracting GLB" k/6 (with inner bars) during
 * /extract_glb. Spans follow how long each part took at 1024. The labels are what the user sees,
 * so they describe the step, never the model.
 */
// `gapTo`: after a bar's final step the Space works silently before the next bar starts (measured
// at 1024: ~13 s between shape and texture, ~8 s of decoding before /image_to_3d returns), so the
// estimate keeps creeping toward this point. 'end' means the end of the whole call.
const PHASES: { match: RegExp; from: number; to: number; label: string; gapTo?: number | 'end' }[] = [
  { match: /sparse structure/i, from: 10, to: 22, label: 'Shaping the object' },
  { match: /shape/i, from: 22, to: 31, label: 'Shaping the object', gapTo: 38 },
  { match: /texture/i, from: 38, to: 48, label: 'Painting the surfaces' },
  { match: /render/i, from: 48, to: 56, label: 'Assembling the model', gapTo: 'end' },
  { match: /extracting glb/i, from: 64, to: 95, label: 'Finishing the mesh and textures', gapTo: 'end' },
];

interface ProgressUnit { index?: number | null; length?: number | null; desc?: string | null }

/**
 * Runs one Space endpoint and passes every status message on. The iterator is read by hand:
 * breaking out of `for await` makes the client wait forever while closing the stream.
 */
async function callWithStatus(client: any, endpoint: string, args: any, onStatus: (status: any) => void): Promise<any[]> {
  const stream = client.submit(endpoint, args)[Symbol.asyncIterator]();
  while (true) {
    const { value: message, done } = await stream.next();
    if (done) throw new Error(`${endpoint} ended without a result.`);
    if (message.type === 'status') {
      if (message.stage === 'error') throw new Error(message.message || `${endpoint} failed.`);
      onStatus(message);
    } else if (message.type === 'data') {
      return message.data as any[];
    }
  }
}

/** Turns one status message into a bar position, if it says anything we can place. */
function placeStatus(status: any, report: ReportProgress, stepEnd: number) {
  if (typeof status.position === 'number' && status.position > 0) {
    const ahead = status.position;
    report(0, `Waiting for a free GPU (${ahead} ahead)`);
    return;
  }
  const bars: ProgressUnit[] = status.progress_data || [];
  const outer = bars[0];
  if (!outer?.desc || !outer.length) return;
  if (/zerogpu init/i.test(outer.desc)) return;
  const phase = PHASES.find((p) => p.match.test(outer.desc!));
  if (!phase) return;
  // An inner bar (e.g. the UV unwrap inside "Extracting GLB" step 3) fills in between outer steps.
  const inner = bars[1];
  const innerFraction = inner?.length ? clamp((inner.index ?? 0) / inner.length, 0, 1) : 0;
  const fraction = clamp(((outer.index ?? 0) + innerFraction) / outer.length, 0, 1);
  const percent = phase.from + (phase.to - phase.from) * fraction;
  // Until the next message, drift toward the end of this step (or of the whole call).
  const lastStep = (outer.index ?? 0) + 1 >= outer.length;
  const next = phase.gapTo !== undefined && lastStep
    ? (phase.gapTo === 'end' ? stepEnd : phase.gapTo)
    : phase.from + ((phase.to - phase.from) * Math.min(outer.length, (outer.index ?? 0) + 1)) / outer.length;
  report(percent, phase.label, { to: Math.min(Math.max(next, percent), stepEnd), expectedMs: lastStep ? 10000 : 6000 });
}

/**
 * Image -> GLB on TRELLIS.2. Returns the Space's URL for the GLB.
 *
 * The Space keeps the generated model in its per-session state between /image_to_3d and
 * /extract_glb, so every generation gets its OWN client (its own session). A shared client
 * would let two people's generations overwrite each other's state.
 */
export async function generateWithTrellis2(image: any, options: Trellis2Options, report: ReportProgress, token?: string): Promise<string> {
  const t = token || getHfToken();
  report(1, 'Connecting', { to: 3, expectedMs: 3000 });
  // 'status' events are off unless asked for; without them there is no progress at all.
  const client = await Client.connect(TRELLIS2_SPACE, { ...(t ? { hf_token: t as `hf_${string}` } : {}), events: ['data', 'status'] });

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
  report(3, 'Preparing your image', { to: 8, expectedMs: 5000 });
  const prep = await callWithStatus(client, '/preprocess_image', { input: image }, (s) => placeStatus(s, report, 8));
  const prepared = prep?.[0];
  if (!prepared) throw new Error('The image could not be prepared.');
  console.log(`[TRELLIS.2] background cut in ${secs()}s; building at ${resolution}...`);

  report(8, 'Starting the GPU', { to: 10, expectedMs: 4000 });
  await callWithStatus(client, '/image_to_3d', { image: prepared, seed, resolution }, (s) => placeStatus(s, report, 62));
  console.log(`[TRELLIS.2] built in ${secs()}s; exporting ${faceTarget} faces, ${textureSize}px texture...`);

  report(62, 'Finishing the mesh and textures', { to: 64, expectedMs: 5000 });
  const exported = await callWithStatus(client, '/extract_glb', { decimation_target: faceTarget, texture_size: textureSize }, (s) => placeStatus(s, report, 95));
  const [shown, download] = exported;
  const glbUrl = resolveMediaUrl(download ?? shown);
  if (!glbUrl) throw new Error('No model file came back.');
  console.log(`[TRELLIS.2] done in ${secs()}s`);
  return glbUrl;
}
