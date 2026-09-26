import type { FilmLook, FilmLookFields } from '../types';

/**
 * The project look library: camera / lens / film / grade recipes the crew collects and later
 * applies to previs frames. Stored on the server per project; this file is the browser's side:
 * the API calls, the reference-picture upload, palette extraction and pasted-details parsing.
 */

export const EMPTY_LOOK: FilmLookFields = {
  name: '',
  source: '',
  camera: '',
  lens: '',
  filmStock: '',
  format: '',
  aspectRatio: '',
  lighting: '',
  colorNotes: '',
  palette: [],
  referenceUrl: '',
  lookPrompt: '',
};

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/looks`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Could not reach the server.');
  }
  const data = await res.json().catch(() => null);
  if (!data?.success) throw new Error(data?.error || `The server answered ${res.status}.`);
  return data as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function listLooks(projectId: string): Promise<FilmLook[]> {
  return (await call<{ looks: FilmLook[] }>(base(projectId))).looks;
}

export async function createLook(projectId: string, fields: FilmLookFields): Promise<FilmLook> {
  return (await call<{ look: FilmLook }>(base(projectId), jsonInit('POST', fields))).look;
}

export async function updateLook(projectId: string, id: string, fields: FilmLookFields): Promise<FilmLook> {
  return (await call<{ look: FilmLook }>(`${base(projectId)}/${id}`, jsonInit('PUT', fields))).look;
}

export async function deleteLook(projectId: string, id: string): Promise<void> {
  await call(`${base(projectId)}/${id}`, { method: 'DELETE' });
}

/** Asks the server's Gemini text model to write the look text from the fields and reference. */
export async function composeLookPrompt(projectId: string, fields: FilmLookFields): Promise<string> {
  return (await call<{ lookPrompt: string }>(`${base(projectId)}/compose`, jsonInit('POST', fields))).lookPrompt;
}

// ---------------------------------------------------------------------------------------------
// Reference picture

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file could not be read as a picture.'));
    img.src = src;
  });
}

/**
 * Shrinks the picture to at most 1600px on its long side and stores it as a JPEG. A reference
 * only needs to carry light, colour and grain, and the text model reads it on every write.
 */
export async function uploadReferenceImage(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('The picture could not be prepared for upload.');

    const filename = `look_ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
    const res = await fetch(`/api/upload-asset?filename=${filename}`, { method: 'POST', body: blob });
    const data = await res.json().catch(() => null);
    if (!data?.success) throw new Error(data?.error || 'The picture could not be uploaded.');
    return data.url as string;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ---------------------------------------------------------------------------------------------
// Palette

const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const toHex = (rgb: number[]) =>
  '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * The picture's main colours, darkest to lightest, like the strip under a ShotDeck still.
 *
 * k-means on a downsampled copy. The starting centres are taken at evenly spaced brightness
 * levels, so the result is the same every time for the same picture and always spans the range
 * from the blacks to the brightest highlight.
 */
export function extractPalette(img: HTMLImageElement, count = 12): string[] {
  const w = 160;
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const pixels: number[][] = [];
  for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]]);
  pixels.sort((a, b) => luminance(a) - luminance(b));

  let centres = Array.from({ length: count }, (_, i) => [...pixels[Math.floor(((i + 0.5) / count) * pixels.length)]]);
  const assign = new Int32Array(pixels.length);

  for (let iter = 0; iter < 10; iter++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let p = 0; p < pixels.length; p++) {
      const [r, g, b] = pixels[p];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const dr = r - centres[c][0], dg = g - centres[c][1], db = b - centres[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[p] = best;
      const s = sums[best];
      s[0] += r; s[1] += g; s[2] += b; s[3]++;
    }
    centres = centres.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c));
  }

  // Colours covering almost none of the frame are noise, not part of the grade.
  const counts = new Array(centres.length).fill(0);
  for (let p = 0; p < assign.length; p++) counts[assign[p]]++;
  const kept = centres.filter((_, i) => counts[i] / pixels.length >= 0.004);

  const hexes = kept.sort((a, b) => luminance(a) - luminance(b)).map(toHex);
  return hexes.filter((hex, i) => hexes.indexOf(hex) === i);
}

// ---------------------------------------------------------------------------------------------
// Pasted shot details

// Labels as ShotDeck and similar references print them. Ones that describe a single shot or its
// credits (genre, actors, shot size...) are listed only so their text doesn't spill into a field.
const DETAIL_LABELS = [
  'FILM STOCK / RESOLUTION', 'FILM STOCK', 'LIGHTING TYPE', 'LENS SIZE', 'ASPECT RATIO', 'TIME OF DAY',
  'INTERIOR/EXTERIOR', 'LOCATION TYPE', 'STORY LOCATION', 'FILMING LOCATION', 'PRODUCTION DESIGNER',
  'COSTUME DESIGNER', 'CINEMATOGRAPHER', 'COLORIST', 'DIRECTOR', 'EDITOR', 'ACTORS', 'GENRE', 'TAGS',
  'SHOT TIME', 'TIME PERIOD', 'FRAME SIZE', 'SHOT TYPE', 'COMPOSITION', 'LIGHTING', 'CAMERA', 'LENS',
  'FORMAT', 'COLOR', 'COLOUR', 'SET',
];

/**
 * Reads "LABEL: value" pairs out of pasted text (one per line or all run together) and returns
 * the look fields they fill. Only fields that were found are returned, so a paste never clears
 * something already typed.
 */
export function parseShotDetails(text: string): Partial<FilmLookFields> {
  const escaped = DETAIL_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  const labelRe = new RegExp(`(?:^|\\s)(${escaped.join('|')})\\s*:`, 'gi');

  const hits: { label: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(text))) {
    const labelStart = m.index + m[0].indexOf(m[1]);
    hits.push({ label: m[1].toUpperCase(), start: labelStart, end: labelRe.lastIndex });
  }

  const values: Record<string, string> = {};
  hits.forEach((hit, i) => {
    const value = text.slice(hit.end, i + 1 < hits.length ? hits[i + 1].start : undefined).replace(/\s+/g, ' ').trim();
    if (value && !values[hit.label]) values[hit.label] = value;
  });

  const out: Partial<FilmLookFields> = {};
  const set = (key: keyof FilmLookFields, value: string | undefined) => {
    if (value) (out as any)[key] = value;
  };

  // Whatever comes before the first label is usually the title, e.g. "THE HANGOVER PART II (2011)".
  const head = (hits.length ? text.slice(0, hits[0].start) : '').replace(/\s+/g, ' ').trim();
  if (head && head.length <= 120) set('source', head);

  set('camera', values['CAMERA']);
  set('lens', values['LENS']);
  set('filmStock', values['FILM STOCK / RESOLUTION'] || values['FILM STOCK']);
  set('format', values['FORMAT']);
  set('aspectRatio', values['ASPECT RATIO']);
  set('colorNotes', values['COLOR'] || values['COLOUR']);
  set(
    'lighting',
    [values['LIGHTING'], values['LIGHTING TYPE'], values['TIME OF DAY']].filter(Boolean).join(' · ')
  );
  return out;
}
