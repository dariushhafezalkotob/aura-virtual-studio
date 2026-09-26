/**
 * The camera package: body, lens set and film back chosen in Camera Record, stored on each take,
 * and turned into sections of the render prompt when a take is sent to rendering.
 *
 * Shared by the browser (the pickers) and the server (which builds the prompt), so the two can
 * never disagree about what an id means. Pure data and string building only - no DOM, no Node.
 *
 * How the sections are written comes from the previs render tests (2026-09-25, Seedream 5 Pro
 * Edit, one section changed at a time):
 * - Film stock moves the picture most, when the difference is bold (black and white, grain,
 *   tungsten-vs-teal). Subtle colour differences between colour stocks barely showed, so colour
 *   itself belongs in the grade.
 * - Lenses show their LOUD traits (streak flares, glow, vignetting, flare colour) and not their
 *   subtle rendering, so each lens leads with what is visible. Bokeh shape and focus fall-off do
 *   not come from words at all: they come from the depth of field already in the previs frame.
 * - Camera bodies are subtle but real up close (RED measurably crisper, ARRI softer skin), so
 *   their sections are short and about sharpness, skin, highlights and noise.
 */

export type CaptureKind = 'digital' | 'film';

export interface CameraBody {
  id: string;
  name: string;
  kind: CaptureKind;
  /** Sensor or gate, shown in the picker. */
  format: string;
  prompt: string;
}

export interface LensSet {
  id: string;
  name: string;
  /** Spherical or anamorphic, vintage or modern - shown in the picker. */
  character: string;
  anamorphic?: boolean;
  prompt: string;
}

export interface FilmBack {
  id: string;
  name: string;
  kind: CaptureKind;
  prompt: string;
}

export interface CameraPackage {
  cameraId: string;
  lensId: string;
  /** A film stock for film cameras; 'digital' for digital ones. */
  backId: string;
}

export const CAMERA_BODIES: CameraBody[] = [
  {
    id: 'alexa35',
    name: 'ARRI Alexa 35',
    kind: 'digital',
    format: 'Super 35 digital',
    prompt:
      'ARRI Alexa 35, Super 35 digital sensor. Very gentle highlight roll-off: bright lamps and windows fade smoothly into white with no hard clipped edge. Natural, slightly warm, film-like colour with soft, creamy skin that keeps its colour in strong light. A fine organic texture in the shadows rather than electronic noise.',
  },
  {
    id: 'alexaminilf',
    name: 'ARRI Alexa Mini LF',
    kind: 'digital',
    format: 'Large format digital',
    prompt:
      'ARRI Alexa Mini LF, large-format digital sensor. The ARRI look on a bigger sensor: gentle highlight roll-off, natural warm colour and soft, creamy skin, with a shallower, smoother depth of field and a wider, more immersive view for the same lens.',
  },
  {
    id: 'vraptor',
    name: 'RED V-Raptor 8K VV',
    kind: 'digital',
    format: 'VistaVision digital',
    prompt:
      'RED V-Raptor 8K VV, large VistaVision digital sensor. A very crisp, highly detailed image with strong micro-contrast: fabric weave, skin pores, stubble and wood grain are resolved sharply. Punchy contrast with a slightly cool, saturated colour response; highlights clip a little more abruptly than film; very clean shadows with almost no noise.',
  },
  {
    id: 'venice2',
    name: 'Sony Venice 2',
    kind: 'digital',
    format: 'Full frame digital',
    prompt:
      'Sony Venice 2, full-frame digital sensor. Clean, neutral, accurate colour with no colour cast, a little cooler and more literal than ARRI. Smooth skin and smooth gradients, very low noise, and exceptional shadow detail: dark areas keep visible texture and colour instead of going black.',
  },
  {
    id: 'dxl2',
    name: 'Panavision DXL2',
    kind: 'digital',
    format: 'Large format digital',
    prompt:
      'Panavision Millennium DXL2, large-format digital sensor with Light Iron colour. Rich, dense, filmic colour with warm, flattering skin; smooth, liquid gradients; high detail without harshness; a shallow, large-format depth of field.',
  },
  {
    id: 'ursa12k',
    name: 'Blackmagic URSA 12K',
    kind: 'digital',
    format: 'Super 35 digital',
    prompt:
      'Blackmagic URSA Mini Pro 12K, Super 35 digital sensor. Very high resolution and fine detail with a natural, slightly organic noise texture; neutral colour; highlights handled softly, shadows with good detail.',
  },
  {
    id: 'arri435',
    name: 'Arri 435',
    kind: 'film',
    format: '35mm film, 4-perf',
    prompt: 'Arri 435 35mm motion picture film camera, 4-perf, 180 degree shutter: a real 35mm film negative image.',
  },
  {
    id: 'millenniumxl2',
    name: 'Panavision Millennium XL2',
    kind: 'film',
    format: '35mm film, 3-perf',
    prompt: 'Panavision Millennium XL2 35mm motion picture film camera, 3-perf: a real 35mm film negative image.',
  },
  {
    id: 'arri416',
    name: 'Arri 416',
    kind: 'film',
    format: 'Super 16 film',
    prompt:
      'Arri 416 Super 16mm film camera: a real 16mm film image, with the grain clearly larger in the frame than on 35mm, slightly softer detail and a raw, documentary texture.',
  },
];

export const LENS_SETS: LensSet[] = [
  {
    id: 'zeisssupreme',
    name: 'Zeiss Supreme Prime',
    character: 'Modern spherical, clean',
    prompt:
      'Zeiss Supreme Prime lens. Very sharp and high-contrast across the whole frame with crisp micro-detail; clean, neutral colour; minimal, well-controlled flare so blacks stay deep; a modern, precise, slightly clinical rendering.',
  },
  {
    id: 'masterprime',
    name: 'ARRI Master Prime',
    character: 'Modern spherical, clean',
    prompt:
      'ARRI Master Prime lens. Sharp in the centre with a gentle softening toward the corners; neutral colour and gentle contrast; almost no flare or ghosting even when a lamp is in frame; a three-dimensional separation of the subject from the background.',
  },
  {
    id: 'cookes4',
    name: 'Cooke S4/i',
    character: 'Spherical, warm',
    prompt:
      'Cooke S4/i lens, the "Cooke look". Sharp but gentle, with softer contrast in fine detail that flatters skin; a warm rendering; soft, warm, subtle flares from bright lights; the image feels smooth and painterly rather than clinical.',
  },
  {
    id: 'primo',
    name: 'Panavision Primo',
    character: 'Spherical, classic',
    prompt:
      'Panavision Primo spherical lens. Clean and sharp with firm contrast; straight lines stay straight; smooth highlights; little flare. A classic, polished studio-film image.',
  },
  {
    id: 'summiluxc',
    name: 'Leica Summilux-C',
    character: 'Spherical, natural',
    prompt:
      'Leica Summilux-C lens. Crisp detail with a natural, true-to-life colour and gentle contrast; very even from centre to edge; flares are faint and neutral; a clean, honest image.',
  },
  {
    id: 'cseries',
    name: 'Panavision C-Series anamorphic',
    character: '2x anamorphic, vintage',
    anamorphic: true,
    prompt:
      'Panavision C-Series 2x anamorphic lens. Every bright light throws a long, thin, horizontal blue streak flare across the frame. Straight lines bow slightly outward near the left and right edges, and the edges and corners are softer than the centre. Out-of-focus highlights are tall vertical ovals. The sharpness is slightly dreamy rather than clinical.',
  },
  {
    id: 'cookeanamorphic',
    name: 'Cooke Anamorphic/i',
    character: '2x anamorphic, warm',
    anamorphic: true,
    prompt:
      'Cooke Anamorphic/i lens. Warm, amber-tinted horizontal streak flares from bright lights; out-of-focus highlights are vertical ovals; gentle barrel bend near the edges; the warm, skin-flattering Cooke rendering.',
  },
  {
    id: 'k35',
    name: 'Canon K35',
    character: 'Vintage spherical, 1970s',
    prompt:
      'Canon K35 vintage 1970s lens. Low contrast with lifted, milky blacks; a strong glow and halation around every bright light; warm amber and purple flares and ghosts; clear vignetting that darkens the corners; a sharp centre with softer edges.',
  },
  {
    id: 'superbaltar',
    name: 'Super Baltar',
    character: 'Vintage spherical, 1960s',
    prompt:
      'Bausch & Lomb Super Baltar vintage lens. Soft overall with a smoky, low-contrast glow around bright areas and around silhouettes; cool blue veiling glare when a light is in frame; highlights bloom into their surroundings; an old-Hollywood, slightly gritty texture.',
  },
  {
    id: 'helios44',
    name: 'Helios 44-2',
    character: 'Vintage spherical, swirly',
    prompt:
      'Helios 44-2 vintage Soviet lens. Sharp only in the centre, falling off quickly toward the edges; low contrast; bright lights produce large, soft, round flare orbs and warm ghosts; darker corners; highlights glow.',
  },
];

export const FILM_BACKS: FilmBack[] = [
  {
    id: 'digital',
    name: 'Digital sensor',
    kind: 'digital',
    prompt: 'A clean digital image with fine, natural sensor noise only in the deepest shadows.',
  },
  {
    id: 'vision3_500t',
    name: 'Kodak Vision3 500T 5219',
    kind: 'film',
    prompt:
      'Kodak Vision3 500T (5219) tungsten film. Visible grain across the frame, strongest in the shadows and dark areas. Warm amber tungsten light against cool teal-cyan shadows; a faint red-orange halation glow around bright lamps and hard highlights; soft, compressed highlights and deep but not crushed blacks.',
  },
  {
    id: 'vision3_250d',
    name: 'Kodak Vision3 250D 5207',
    kind: 'film',
    prompt:
      'Kodak Vision3 250D (5207) daylight film. Fine, tight grain; rich but natural saturation; very wide latitude with detail kept in both highlights and shadows; under tungsten light without correction the whole image turns clearly warm orange.',
  },
  {
    id: 'vision3_200t',
    name: 'Kodak Vision3 200T 5213',
    kind: 'film',
    prompt:
      'Kodak Vision3 200T (5213) tungsten film. Fine grain, clean and smooth; true tungsten colour with warm lamps and neutral-cool shadows; gentle halation around bright highlights.',
  },
  {
    id: 'vision3_50d',
    name: 'Kodak Vision3 50D 5203',
    kind: 'film',
    prompt:
      'Kodak Vision3 50D (5203) daylight film. Extremely fine grain, almost invisible; very clean, rich, saturated colour and crisp detail; the look of a slow film stock in bright light.',
  },
  {
    id: 'eterna250d',
    name: 'Fujifilm Eterna 250D',
    kind: 'film',
    prompt:
      'Fujifilm Eterna 250D film. Low-contrast, muted, pastel colour with slightly green-leaning shadows and soft magenta-leaning skin; fine grain; gentle, flat highlight roll-off.',
  },
  {
    id: 'doublex',
    name: 'Kodak Double-X 5222 (B&W)',
    kind: 'film',
    prompt:
      'Kodak Double-X 5222 black-and-white negative film. Fully monochrome: every object, including skin, drinks, lights and brass, is a shade of grey, with no colour anywhere. Classic, clearly visible silver grain; rich blacks and bright, glowing highlights with strong contrast.',
  },
  {
    id: 'ektachrome100d',
    name: 'Kodak Ektachrome 100D',
    kind: 'film',
    prompt:
      'Kodak Ektachrome 100D colour reversal film. Vivid, punchy, highly saturated colour with deep blue skies and strong reds; high contrast with dense blacks and bright highlights that clip quickly; fine grain.',
  },
];

export const DEFAULT_PACKAGE: CameraPackage = { cameraId: 'alexa35', lensId: 'cookes4', backId: 'digital' };

export const cameraById = (id: string) => CAMERA_BODIES.find((c) => c.id === id);
export const lensById = (id: string) => LENS_SETS.find((l) => l.id === id);
export const backById = (id: string) => FILM_BACKS.find((b) => b.id === id);

/** Film backs that fit this camera: digital bodies record digitally, film bodies take a stock. */
export function backsFor(cameraId: string): FilmBack[] {
  const kind = cameraById(cameraId)?.kind ?? 'digital';
  return FILM_BACKS.filter((b) => b.kind === kind);
}

/**
 * Makes a package consistent: unknown ids fall back to the default, and the film back always
 * matches the camera (a film camera cannot record "digital", a digital one cannot load 500T).
 */
export function normalizePackage(input: Partial<CameraPackage> | null | undefined): CameraPackage {
  const camera = cameraById(input?.cameraId || '') || cameraById(DEFAULT_PACKAGE.cameraId)!;
  const lens = lensById(input?.lensId || '') || lensById(DEFAULT_PACKAGE.lensId)!;
  const fits = backsFor(camera.id);
  const back = fits.find((b) => b.id === input?.backId) || fits[0];
  return { cameraId: camera.id, lensId: lens.id, backId: back.id };
}

/** "Alexa 35 · Cooke S4/i · Digital", for buttons and take badges. */
export function packageLabel(pkg: CameraPackage | undefined): string {
  if (!pkg) return 'No package';
  const p = normalizePackage(pkg);
  return [cameraById(p.cameraId)!.name, lensById(p.lensId)!.name, backById(p.backId)!.name].join(' · ');
}

export interface LensSettings {
  /** e.g. "35mm". */
  focalLength?: string;
  /** e.g. "f/2.8", or "OFF" when the viewport had depth of field off. */
  aperture?: string;
  /** e.g. "800". */
  iso?: string;
}

/**
 * The camera, lens and film sections of the render prompt, in that order. Focal length and stop
 * come from the take, so the lens section names the exact lens the operator shot with.
 */
export function packagePromptSections(input: CameraPackage, settings: LensSettings = {}): string[] {
  const pkg = normalizePackage(input);
  const camera = cameraById(pkg.cameraId)!;
  const lens = lensById(pkg.lensId)!;
  const back = backById(pkg.backId)!;

  const stop = settings.aperture && settings.aperture !== 'OFF' ? ` at ${settings.aperture.replace('f/', 'T')}` : '';
  const focal = settings.focalLength ? ` ${settings.focalLength}` : '';
  const iso = camera.kind === 'digital' && settings.iso ? ` Shot at ${settings.iso} ISO.` : '';

  return [
    `Camera: ${camera.prompt}${iso}`,
    `Lens:${focal}${stop}. ${lens.prompt}`,
    camera.kind === 'film' ? `Film stock: ${back.prompt}` : `Capture: ${back.prompt}`,
  ];
}
