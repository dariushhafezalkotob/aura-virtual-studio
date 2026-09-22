import { FilmScene, Project, SceneSetting, SceneTimeOfDay } from '../types';

/**
 * Scenes inside a film.
 *
 * A scene holds exactly what a project used to hold - set, actors, takes - so the three studio
 * screens keep working unchanged: they are handed a scene dressed as a project, and what they
 * hand back is folded into that scene.
 */

/** Fields that belong to a scene rather than to the film as a whole. */
const SCENE_CONTENT_KEYS = [
  'scenes',
  'characters',
  'cameraTakes',
  'pointLights',
  'panoramaUrl',
  'panoramaRotation',
  'panoramaBlur',
  'showPanorama',
  'splatUrl',
  'stageSpecularity',
  'lightIntensity',
  'environmentPreset',
  'dialogue',
] as const;

export const SETTING_LABELS: Record<SceneSetting, string> = {
  interior: 'INT.',
  exterior: 'EXT.',
};

export const TIME_LABELS: Record<SceneTimeOfDay, string> = {
  day: 'DAY',
  night: 'NIGHT',
  dawn: 'DAWN',
  dusk: 'DUSK',
};

/** "01 · EXT. BAR — DAY", the way it reads on a script page. */
export function sluglineFor(scene: FilmScene): string {
  const place = (scene.title || 'untitled').toUpperCase();
  return `${SETTING_LABELS[scene.setting]} ${place} — ${TIME_LABELS[scene.timeOfDay]}`;
}

export function nextSceneNumber(scenes: FilmScene[]): string {
  const highest = scenes.reduce((max, s) => {
    const n = parseInt(s.number, 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return String(highest + 1).padStart(2, '0');
}

/**
 * The film's scenes. A project made before scenes existed keeps all its work: its set, actors
 * and takes become Scene 01 rather than disappearing.
 */
export function scenesOf(project: Project): FilmScene[] {
  if (project.filmScenes && project.filmScenes.length > 0) return project.filmScenes;

  const hasContent =
    (project.scenes && project.scenes.length > 0) ||
    (project.characters && project.characters.length > 0) ||
    (project.cameraTakes && project.cameraTakes.length > 0) ||
    !!project.panoramaUrl ||
    !!project.splatUrl;

  if (!hasContent) return [];

  const legacy: any = { id: `scene_${project.id}`, number: '01', title: project.name, setting: 'interior', timeOfDay: 'day' };
  for (const key of SCENE_CONTENT_KEYS) {
    if (project[key] !== undefined) legacy[key] = project[key];
  }
  return [legacy as FilmScene];
}

export function createScene(input: {
  number: string;
  title: string;
  setting: SceneSetting;
  timeOfDay: SceneTimeOfDay;
  notes?: string;
}): FilmScene {
  return {
    id: `scene_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    number: input.number.trim() || '01',
    title: input.title.trim(),
    setting: input.setting,
    timeOfDay: input.timeOfDay,
    notes: input.notes?.trim() || undefined,
    createdAt: new Date().toISOString(),
    scenes: [],
    characters: [],
    cameraTakes: [],
  };
}

export function withScenes(project: Project, scenes: FilmScene[]): Project {
  // Content now lives on the scenes; clearing the old top-level copies stops the two drifting
  // apart and stops a legacy project being wrapped a second time.
  const cleared: any = { ...project, filmScenes: scenes, modified: 'Just now' };
  for (const key of SCENE_CONTENT_KEYS) delete cleared[key];
  return cleared as Project;
}

export function upsertScene(project: Project, scene: FilmScene): Project {
  const scenes = scenesOf(project);
  const index = scenes.findIndex((s) => s.id === scene.id);
  const next = index >= 0 ? scenes.map((s) => (s.id === scene.id ? scene : s)) : [...scenes, scene];
  return withScenes(project, next);
}

export function removeScene(project: Project, sceneId: string): Project {
  return withScenes(
    project,
    scenesOf(project).filter((s) => s.id !== sceneId)
  );
}

/**
 * A scene dressed as a project, so SceneDesignView, ActingSetupView and CameraRecordView can be
 * handed one without knowing scenes exist.
 */
export function sceneAsProject(project: Project, scene: FilmScene): Project {
  const view: any = { ...project };
  delete view.filmScenes;
  for (const key of SCENE_CONTENT_KEYS) {
    view[key] = (scene as any)[key];
  }
  // Keep the scene's identity available for anything that wants to label the screen - or, in the
  // camera remote's case, to give each scene its own pairing room rather than one per film.
  view.name = `${project.name} · ${scene.number}`;
  view.sceneId = scene.id;
  return view as Project;
}

/** Folds what one of those screens handed back into the scene it was editing. */
export function applySceneEdit(project: Project, sceneId: string, edited: Project): Project {
  const scenes = scenesOf(project);
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) return project;

  const updated: any = { ...scene };
  for (const key of SCENE_CONTENT_KEYS) {
    updated[key] = (edited as any)[key];
  }
  return upsertScene(project, updated as FilmScene);
}
