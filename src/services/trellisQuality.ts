/**
 * Quality presets for the TRELLIS Space (dariushh-trellis-3d-engine).
 *
 * Ranges come from the Space's own sliders, so nothing here can be out of bounds:
 *   seed 0-2147483647 · guidance 0-10 · sampling steps 1-50
 *   mesh_simplify 0.9-0.98 step 0.01 (LOWER keeps more faces) · texture_size 512-2048 step 512
 *
 * Guidance is left at the Space's defaults (7.5 / 3.0): it steers how closely the result
 * follows the image, not how much detail survives.
 */
export type TrellisQuality = 'fast' | 'high' | 'max';

export interface TrellisQualitySettings {
  ssSteps: number;
  slatSteps: number;
  simplify: number;
  textureSize: number;
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
    ssSteps: 20,
    slatSteps: 20,
    simplify: 0.95,
    textureSize: 2048,
    costHint: '~2× slower',
    description: 'More faces kept and a 2K texture. Best all-round setting.',
  },
  {
    id: 'max',
    label: 'MAX',
    ssSteps: 32,
    slatSteps: 32,
    simplify: 0.9,
    textureSize: 2048,
    costHint: '~3× slower',
    description: 'Densest mesh the engine allows, 2K texture. Slow, and can hit the GPU time limit.',
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
