/**
 * Quality presets. FAST runs the original TRELLIS Space (dariushh-trellis-3d-engine); HIGH and MAX
 * run TRELLIS.2 (dariushh-trellis2-3d-engine), which keeps far more detail.
 *
 * TRELLIS ranges come from that Space's own sliders:
 *   seed 0-2147483647 · guidance 0-10 · sampling steps 1-50
 *   mesh_simplify 0.9-0.98 step 0.01 (LOWER keeps more faces) · texture_size 512-2048 step 512
 * Its MAX (simplify 0.9) was measured at ~46k triangles: that is the model's ceiling, not a setting.
 *
 * TRELLIS.2, measured 2026-10-01 on one prop: 1024 + 300k faces -> 292k triangles, 13 MB, ~80 s;
 * 1024 + 500k -> 477k triangles, 20 MB, ~75 s; 1536 + 500k -> 480k triangles, 20 MB, ~130 s.
 * The detail comes from the face target, not the grid: the export decimates to the target either way.
 * Do NOT use 1536 for MAX: on pantilt.app a more complex prop ran the GPU out of memory while
 * decimating the 1536 mesh, and it bought nothing over 1024.
 *
 * Guidance is left at each Space's defaults: it steers how closely the result follows the image,
 * not how much detail survives.
 */
export type TrellisQuality = 'fast' | 'high' | 'max';

export type TrellisModel = 'trellis' | 'trellis2';

export interface TrellisQualitySettings {
  model: TrellisModel;
  /** TRELLIS only. */
  ssSteps: number;
  slatSteps: number;
  simplify: number;
  textureSize: number;
  /** TRELLIS.2 only: voxel grid resolution and the triangle budget of the exported mesh. */
  resolution?: 512 | 1024 | 1536;
  faceTarget?: number;
}

export interface TrellisQualityPreset extends TrellisQualitySettings {
  id: TrellisQuality;
  label: string;
  /** Rough time compared with FAST, for the tooltip. */
  costHint: string;
  description: string;
}

export const TRELLIS_QUALITY_PRESETS: TrellisQualityPreset[] = [
  {
    id: 'fast',
    label: 'FAST',
    model: 'trellis',
    ssSteps: 12,
    slatSteps: 12,
    simplify: 0.98,
    textureSize: 1024,
    costHint: 'quickest',
    description: 'Draft mesh, 1K texture. Good for blocking out a scene.',
  },
  {
    id: 'high',
    label: 'HIGH',
    model: 'trellis2',
    ssSteps: 20,
    slatSteps: 20,
    simplify: 0.95,
    textureSize: 2048,
    resolution: 1024,
    faceTarget: 300000,
    costHint: '~1.5 min',
    description: 'Fine detail (~300k triangles), 2K texture with metal and roughness. Best all-round setting.',
  },
  {
    id: 'max',
    label: 'MAX',
    model: 'trellis2',
    ssSteps: 32,
    slatSteps: 32,
    simplify: 0.9,
    textureSize: 2048,
    resolution: 1024,
    faceTarget: 500000,
    costHint: '~1.5 min',
    description: 'The most detail (~500k triangles), 2K texture. Bigger files (~20 MB).',
  },
];

export const DEFAULT_TRELLIS_QUALITY: TrellisQuality = 'high';

const STORAGE_KEY = 'trellis_quality';

export function getTrellisQualityPreset(id: TrellisQuality): TrellisQualityPreset {
  return TRELLIS_QUALITY_PRESETS.find((p) => p.id === id) || TRELLIS_QUALITY_PRESETS[1];
}

export function loadTrellisQuality(): TrellisQuality {
  if (typeof window === 'undefined') return DEFAULT_TRELLIS_QUALITY;
  const saved = localStorage.getItem(STORAGE_KEY) as TrellisQuality | null;
  return saved && TRELLIS_QUALITY_PRESETS.some((p) => p.id === saved) ? saved : DEFAULT_TRELLIS_QUALITY;
}

export function saveTrellisQuality(id: TrellisQuality) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch (_) {
    /* private window: the choice just won't persist */
  }
}
