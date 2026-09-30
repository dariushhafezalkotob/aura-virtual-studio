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

/** Depth per pixel in metres (row 0 at the top, Infinity for sky), as the viewport captured it. */
export interface DepthInfo {
  width: number;
  height: number;
  metres: Float32Array;
}

/** The lens the viewport drew frame 1 with. `stop` is null when depth of field was off. */
export interface LensAtFrame {
  focalMm: number;
  stop: number | null;
  focusM: number;
}

/** What the lens keeps sharp, for the prompt: focus distance and the near and far limits. */
export interface DepthOfFieldSummary {
  focusM: number;
  nearM: number;
  farM: number | null;
  focalMm: number;
  stop: number;
}

// Super 35 gate width and the usual circle of confusion for it.
const SENSOR_WIDTH_MM = 24.89;
const COC_MM = 0.025;
const PASS_W = 960;
const PASS_H = 540;

/** Near and far limits of acceptable focus (hyperfocal method). farM is null when it reaches infinity. */
export function depthOfField(lens: LensAtFrame): DepthOfFieldSummary | null {
  if (!lens.stop) return null;
  const f = lens.focalMm / 1000;
  const c = COC_MM / 1000;
  const s = Math.max(0.3, lens.focusM);
  const hyper = (f * f) / (lens.stop * c) + f;
  const near = (s * (hyper - f)) / (hyper + s - 2 * f);
  const far = s < hyper ? (s * (hyper - f)) / (hyper - s) : null;
  return { focusM: s, nearM: near, farM: far, focalMm: lens.focalMm, stop: lens.stop };
}

/** Blur radius in pass pixels for something `z` metres away: the thin-lens circle of confusion. */
function blurRadiusPx(z: number, lens: LensAtFrame): number {
  if (!lens.stop) return 0;
  const f = lens.focalMm / 1000;
  const s = Math.max(0.3, lens.focusM);
  const dist = Number.isFinite(z) ? Math.max(0.05, z) : 1e6;
  const cocM = (Math.abs(dist - s) / dist) * ((f * f) / (lens.stop * Math.max(1e-4, s - f)));
  const diameterPx = (cocM * 1000 / SENSOR_WIDTH_MM) * PASS_W;
  return Math.min(24, diameterPx / 2);
}

/** Crops the viewport-shaped depth to the same centred 16:9 as the frame and resizes it to the pass. */
function depthForPass(depth: DepthInfo): Float32Array {
  const target = 16 / 9;
  let sx = 0, sy = 0, sw = depth.width, sh = depth.height;
  if (sw / sh > target) {
    sw = sh * target;
    sx = (depth.width - sw) / 2;
  } else {
    sh = sw / target;
    sy = (depth.height - sh) / 2;
  }
  const out = new Float32Array(PASS_W * PASS_H);
  for (let y = 0; y < PASS_H; y++) {
    const yy = Math.min(depth.height - 1, Math.floor(sy + ((y + 0.5) / PASS_H) * sh));
    for (let x = 0; x < PASS_W; x++) {
      const xx = Math.min(depth.width - 1, Math.floor(sx + ((x + 0.5) / PASS_W) * sw));
      out[y * PASS_W + x] = depth.metres[yy * depth.width + xx];
    }
  }
  return out;
}

/** Box blur with integer radius, run horizontally then vertically. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / span;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / span;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Two box passes: close to a gaussian of the same size. */
const softBlur = (src: Float32Array, w: number, h: number, r: number) =>
  r < 1 ? src.slice() : boxBlur(boxBlur(src, w, h, Math.max(1, Math.round(r * 0.6))), w, h, Math.max(1, Math.round(r * 0.6)));

/**
 * Puts depth back into a grey pass. Every pixel is blurred by what the lens would blur it at its
 * distance (plus `baseBlur` everywhere), by blending between a few pre-blurred copies; then
 * distant parts are lifted toward a pale haze, so a grey picture still reads near and far.
 */
function applyDepth(grey: Float32Array, depth: Float32Array | null, lens: LensAtFrame | null, baseBlur: number, haze: number): Float32Array {
  const w = PASS_W;
  const h = PASS_H;
  const radii = [0, 1.5, 3, 6, 12, 24];
  const levels = radii.map((r) => softBlur(grey, w, h, r));
  const out = new Float32Array(w * h);

  let lo = 0, hi = 1;
  if (depth) {
    const finite = Array.from(depth).filter(Number.isFinite).sort((a, b) => a - b);
    if (finite.length > 100) {
      lo = finite[Math.floor(finite.length * 0.05)];
      hi = Math.max(lo + 0.5, finite[Math.floor(finite.length * 0.95)]);
    }
  }

  for (let p = 0; p < out.length; p++) {
    const z = depth ? depth[p] : NaN;
    const r = Math.min(24, baseBlur + (depth && lens ? blurRadiusPx(z, lens) : 0));
    let i = 0;
    while (i < radii.length - 2 && radii[i + 1] < r) i++;
    const t = Math.min(1, Math.max(0, (r - radii[i]) / (radii[i + 1] - radii[i])));
    let v = levels[i][p] * (1 - t) + levels[i + 1][p] * t;
    if (depth && haze > 0) {
      const far = Number.isFinite(z) ? Math.min(1, Math.max(0, (z - lo) / (hi - lo))) : 1;
      v = v * (1 - haze * far) + 205 * haze * far;
    }
    out[p] = v;
  }
  return out;
}

function greyOf(img: HTMLImageElement): Float32Array {
  const c = document.createElement('canvas');
  c.width = PASS_W;
  c.height = PASS_H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, PASS_W, PASS_H);
  const src = ctx.getImageData(0, 0, PASS_W, PASS_H).data;
  const grey = new Float32Array(PASS_W * PASS_H);
  for (let i = 0, p = 0; p < grey.length; i += 4, p++) grey[p] = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
  return grey;
}

function toJpeg(values: Float32Array, softenPx = 0): string {
  const work = document.createElement('canvas');
  work.width = PASS_W;
  work.height = PASS_H;
  const ctx = work.getContext('2d')!;
  const img = ctx.createImageData(PASS_W, PASS_H);
  for (let p = 0, i = 0; p < values.length; p++, i += 4) {
    const v = Math.max(0, Math.min(255, values[p]));
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const full = document.createElement('canvas');
  full.width = 1920;
  full.height = 1080;
  const fctx = full.getContext('2d')!;
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  if (softenPx > 0) fctx.filter = `blur(${softenPx}px)`;
  fctx.drawImage(work, 0, 0, full.width, full.height);
  return full.toDataURL('image/jpeg', 0.9);
}

/**
 * Which actor covers each pixel of the camera frame at frame 1: 0 for none, n for `actorIds[n - 1]`,
 * row 0 at the top. `ids` is what the camera sees (things in front hide the actor), `fullIds` is the
 * whole figure as if nothing stood in front, cut only by the frame edge.
 */
export interface PeopleMask {
  width: number;
  height: number;
  ids: Uint8Array;
  fullIds: Uint8Array;
  actorIds: string[];
}

export interface PassDepth {
  depth: DepthInfo | null;
  lens: LensAtFrame | null;
  /** Where the actors are, so the pass can keep them readable. */
  people?: PeopleMask | null;
}

/** The mask resampled to the pass size, nearest pixel. */
function maskForPass(mask: Uint8Array, mw: number, mh: number): Uint8Array {
  const out = new Uint8Array(PASS_W * PASS_H);
  for (let y = 0; y < PASS_H; y++) {
    const yy = Math.min(mh - 1, Math.floor(((y + 0.5) / PASS_H) * mh));
    for (let x = 0; x < PASS_W; x++) {
      out[y * PASS_W + x] = mask[yy * mw + Math.min(mw - 1, Math.floor(((x + 0.5) / PASS_W) * mw))];
    }
  }
  return out;
}

/**
 * Puts the actors back into a finished pass, readable. Seedream keeps "every person's position and
 * pose" from image 1, but in grey a turquoise stand-in is about as bright as a dark shop front, and
 * the pass's base blur plus the lens blur smeared a small, out-of-focus figure into the background:
 * with no figure there, Seedream put the person where it liked - big, centred, in the street.
 *
 * So each visible figure is redrawn from the unblurred grey frame with only a little softness, and
 * pushed at least ~55 grey levels away from what surrounds it. Only the actor's own visible pixels
 * change: what stands in front of them still hides them, and the rest of the pass is untouched.
 */
function restorePeople(pass: Float32Array, grey: Float32Array, people: PeopleMask): Float32Array {
  const w = PASS_W;
  const h = PASS_H;
  const ids = maskForPass(people.ids, people.width, people.height);
  const out = pass.slice();
  const sharp = softBlur(grey, w, h, 1.5);

  for (let n = 1; n <= people.actorIds.length; n++) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0, figSum = 0;
    for (let p = 0; p < ids.length; p++) {
      if (ids[p] !== n) continue;
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      count++;
      figSum += sharp[p];
    }
    if (count < 12) continue;

    // What surrounds the figure in the finished pass: a margin around its box, minus the figure.
    const m = Math.max(6, Math.round((y1 - y0) * 0.15));
    let bgSum = 0, bgCount = 0;
    for (let y = Math.max(0, y0 - m); y <= Math.min(h - 1, y1 + m); y++) {
      for (let x = Math.max(0, x0 - m); x <= Math.min(w - 1, x1 + m); x++) {
        const p = y * w + x;
        if (ids[p] === 0) { bgSum += pass[p]; bgCount++; }
      }
    }
    const fig = figSum / count;
    const bg = bgCount ? bgSum / bgCount : 128;
    const gap = fig - bg;
    const MIN_GAP = 55;
    // Lighter than a dark surround, darker than a light one; left alone when it already stands out.
    const dir = gap !== 0 ? Math.sign(gap) : bg < 128 ? 1 : -1;
    let shift = Math.abs(gap) >= MIN_GAP ? 0 : dir * (MIN_GAP - Math.abs(gap));
    if (fig + shift > 235) shift = 235 - fig;
    if (fig + shift < 20) shift = 20 - fig;

    // A one-pixel feather so the figure is not a cut-out.
    for (let y = Math.max(0, y0 - 1); y <= Math.min(h - 1, y1 + 1); y++) {
      for (let x = Math.max(0, x0 - 1); x <= Math.min(w - 1, x1 + 1); x++) {
        const p = y * w + x;
        let inside = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
            total++;
            if (ids[yy * w + xx] === n) inside++;
          }
        }
        if (!inside) continue;
        const a = ids[p] === n ? 0.5 + 0.5 * (inside / total) : 0.5 * (inside / total);
        const v = Math.max(0, Math.min(255, sharp[p] + shift));
        out[p] = out[p] * (1 - a) + v * a;
      }
    }
  }
  return out;
}

const withPeople = (pass: Float32Array, grey: Float32Array, people?: PeopleMask | null) =>
  people ? restorePeople(pass, grey, people) : pass;

/** Size, place and how much is hidden, per actor, measured from the frame-1 masks. */
export interface PersonPlacement {
  actorId: string;
  /** Box centre, 0 at the left edge and 1 at the right. */
  centreX: number;
  /** Whole-figure height as a share of the frame height. */
  heightShare: number;
  /** Share of the whole figure that the camera actually sees (the rest is behind something). */
  visibleShare: number;
  /** Frame edges the figure runs off. */
  cutBy: ('left' | 'right' | 'top' | 'bottom')[];
  /** Bottom of the figure, 0 at the bottom edge and 1 at the top. */
  feetUp: number;
}

export function measurePeople(people: PeopleMask): PersonPlacement[] {
  const { width: w, height: h } = people;
  const out: PersonPlacement[] = [];
  for (let n = 1; n <= people.actorIds.length; n++) {
    let seen = 0, whole = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let p = 0; p < people.ids.length; p++) {
      if (people.ids[p] === n) seen++;
      if (people.fullIds[p] !== n) continue;
      whole++;
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!seen || !whole) continue;
    const cutBy: PersonPlacement['cutBy'] = [];
    if (x0 <= 0) cutBy.push('left');
    if (x1 >= w - 1) cutBy.push('right');
    if (y0 <= 0) cutBy.push('top');
    if (y1 >= h - 1) cutBy.push('bottom');
    out.push({
      actorId: people.actorIds[n - 1],
      centreX: (x0 + x1 + 1) / 2 / w,
      heightShare: (y1 - y0 + 1) / h,
      visibleShare: Math.min(1, seen / whole),
      cutBy,
      feetUp: 1 - (y1 + 1) / h,
    });
  }
  return out;
}

/**
 * One plain sentence per person for the prompt: how big they are, where across the frame, and
 * what hides them. Words only back the picture up; image 1 carries the exact shape.
 */
export function placementSentence(who: string, p: PersonPlacement): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const size =
    p.heightShare < 0.2 ? 'small and far off' : p.heightShare < 0.45 ? 'small in the frame' : p.heightShare < 0.75 ? 'mid-sized in the frame' : 'large in the frame';
  const across =
    p.centreX < 0.2 ? 'at the far left' : p.centreX < 0.4 ? 'left of centre' : p.centreX <= 0.6 ? 'in the centre' : p.centreX <= 0.8 ? 'right of centre' : 'at the far right';
  const parts = [
    `${who} is ${size}, ${across} (about ${pct(p.centreX)} from the left edge), about ${pct(Math.min(1, p.heightShare))} of the frame's height`,
  ];
  if (p.visibleShare < 0.85) parts.push(`partly hidden behind what stands in front of them in image 1, with only about ${pct(p.visibleShare)} of them showing`);
  if (p.cutBy.length) parts.push(`cut off by the ${p.cutBy.join(' and ')} edge of the frame`);
  else if (p.feetUp > 0.03) parts.push(`feet about ${pct(p.feetUp)} up from the bottom edge`);
  return `${parts.join(', ')}. Keep them exactly there, at exactly that size, and do not move them into the open.`;
}

/**
 * The blur pass: grey, low contrast and blurred, so only the camera, the shapes and the poses
 * survive - the hand-made pass that tested best for interiors. With depth, the blur follows the
 * lens: things in focus get only the light base blur that strips texture, the rest blurs as far as
 * the lens would blur it, and distance lifts toward haze.
 */
export async function makeBlurPass(frameDataUrl: string, extra: PassDepth = { depth: null, lens: null }): Promise<string> {
  const grey = greyOf(await loadImage(frameDataUrl));
  for (let p = 0; p < grey.length; p++) grey[p] = (grey[p] - 128) * 0.8 + 128;
  const depth = extra.depth ? depthForPass(extra.depth) : null;
  return toJpeg(withPeople(applyDepth(grey, depth, extra.lens, 3, 0.25), grey, extra.people));
}

/**
 * The clay pass: grey, smoothed and flattened into eight tones, so every edge and window the
 * textures draw survives as a flat shape while colour and CG surface detail are gone. Made from
 * the textured frame, not by re-rendering the models: scanned and generated sets keep most of
 * their detail in their textures, and a real grey-material render of them came out as flat
 * silhouettes with the cars lost against the road (tested on pantilt.app, 2026-09-28).
 *
 * Greyscale, a median filter (smooths texture noise but keeps edges), posterize to 3 bits - the
 * hand-made pass that tested best for exteriors - then, with depth, the lens blur and haze.
 */
export async function makeClayPass(frameDataUrl: string, extra: PassDepth = { depth: null, lens: null }): Promise<string> {
  const grey = greyOf(await loadImage(frameDataUrl));
  const w = PASS_W;
  const h = PASS_H;

  // 5x5 median at half size is the 9x9 median of the full-size hand pass.
  const r = 2;
  const flat = new Float32Array(w * h);
  const hist = new Uint16Array(256);
  const n = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      hist.fill(0);
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
        for (let dx = -r; dx <= r; dx++) hist[grey[yy + Math.min(w - 1, Math.max(0, x + dx))] | 0]++;
      }
      let count = 0;
      let v = 0;
      while ((count += hist[v]) <= n >> 1) v++;
      flat[y * w + x] = v & 0xe0; // 3 bits: eight flat tones
    }
  }

  const depth = extra.depth ? depthForPass(extra.depth) : null;
  return toJpeg(withPeople(applyDepth(flat, depth, extra.lens, 0, 0.35), grey, extra.people), 1);
}

/**
 * Sends a take's first frame to the server for a realistic render (Gemini describes the shot,
 * Seedream 5 Pro renders it). The server answers at once with a job; this polls until it is done.
 */

/** A character whose reference sheet goes with the render, and the stand-in colour that marks them. */
export interface CastReference {
  name: string;
  /** How the stand-in reads in the previs, e.g. "turquoise". */
  colorName: string;
  sheetUrl: string;
}

/**
 * A plain colour word for a stand-in's hex colour, for the prompt: "the turquoise figure is image 3".
 * Previs stand-ins are single flat colours, so the name only has to separate them from each other.
 */
export function standInColourName(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'turquoise';
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.12) return l > 0.8 ? 'white' : l < 0.2 ? 'black' : 'grey';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 65) return 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'turquoise';
  if (h < 250) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

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
  /** What the lens kept sharp in the frame, so the prompt can name it. */
  dof?: DepthOfFieldSummary | null;
  /** Characters whose sheets go along as images after the layout pass and the look. */
  cast?: CastReference[];
  /** One sentence per person in the frame on where they are and how big, from the frame-1 masks. */
  placements?: string[];
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
