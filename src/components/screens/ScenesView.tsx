import React, { useState } from 'react';
import { FilmScene, Project, SceneSetting, SceneTimeOfDay } from '../../types';
import {
  SETTING_LABELS,
  TIME_LABELS,
  createScene,
  nextSceneNumber,
  removeScene,
  scenesOf,
  sluglineFor,
  upsertScene,
} from '../../services/filmScenes';

interface ScenesViewProps {
  currentProject: Project;
  onUpdateProject: (project: Project) => void;
  onOpenScene: (sceneId: string) => void;
  onOpenCrew?: () => void;
}

const SETTINGS: SceneSetting[] = ['interior', 'exterior'];
const TIMES: SceneTimeOfDay[] = ['day', 'night', 'dawn', 'dusk'];

/** The film's scene list: add a scene, edit its slugline, open it to work on it. */
export const ScenesView: React.FC<ScenesViewProps> = ({
  currentProject,
  onUpdateProject,
  onOpenScene,
  onOpenCrew,
}) => {
  const scenes = scenesOf(currentProject);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [setting, setSetting] = useState<SceneSetting>('interior');
  const [timeOfDay, setTimeOfDay] = useState<SceneTimeOfDay>('day');

  const startAdd = () => {
    setNumber(nextSceneNumber(scenes));
    setTitle('');
    setSetting('interior');
    setTimeOfDay('day');
    setEditingId(null);
    setAdding(true);
  };

  const startEdit = (scene: FilmScene) => {
    setNumber(scene.number);
    setTitle(scene.title);
    setSetting(scene.setting);
    setTimeOfDay(scene.timeOfDay);
    setAdding(false);
    setEditingId(scene.id);
  };

  const cancel = () => {
    setAdding(false);
    setEditingId(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId) {
      const existing = scenes.find((s) => s.id === editingId);
      if (existing) {
        onUpdateProject(
          upsertScene(currentProject, { ...existing, number: number.trim(), title: title.trim(), setting, timeOfDay })
        );
      }
    } else {
      onUpdateProject(upsertScene(currentProject, createScene({ number, title, setting, timeOfDay })));
    }
    cancel();
  };

  const remove = (scene: FilmScene) => {
    const shots = (scene.cameraTakes || []).length;
    const warning = shots > 0 ? `\n\nThis deletes its ${shots} take${shots === 1 ? '' : 's'} as well.` : '';
    if (!confirm(`Delete scene ${scene.number} — ${scene.title || 'untitled'}?${warning}`)) return;
    onUpdateProject(removeScene(currentProject, scene.id));
  };

  const formOpen = adding || editingId !== null;

  return (
    <div className="flex-1 w-full h-full overflow-y-auto overflow-x-hidden">
      <main className="flex flex-col items-center justify-start pt-xl px-gutter md:px-margin-safe pb-28 max-w-5xl mx-auto w-full">
        <header className="w-full flex flex-col items-center text-center mb-xl gap-sm">
          <span className="font-label-caps text-[11px] text-on-surface-variant tracking-[0.25em] uppercase">
            {currentProject.name}
          </span>
          <h2 className="font-display-lg text-[34px] md:text-[42px] text-primary font-light leading-tight">Scenes</h2>
          <p className="font-body-md text-sm text-on-surface-variant opacity-80 max-w-lg">
            Every scene has its own set, its own actors and its own takes. Open one to design it,
            direct it and shoot it.
          </p>

          <div className="flex items-center gap-sm mt-sm">
            <button
              onClick={startAdd}
              className="font-label-caps text-[11px] text-primary border border-primary px-lg py-sm hover:bg-primary hover:text-background transition-colors cursor-pointer uppercase tracking-widest font-medium"
            >
              + New scene
            </button>
            {onOpenCrew && (
              <button
                onClick={onOpenCrew}
                className="inline-flex items-center gap-xs px-md py-sm rounded-lg border border-outline-variant/50 bg-surface-container/60 text-on-surface-variant hover:text-primary hover:border-primary/50 transition-colors cursor-pointer text-[11px] font-label-caps tracking-wider"
              >
                <span className="material-symbols-outlined text-[16px]">group</span>
                CREW
              </button>
            )}
          </div>
        </header>

        {formOpen && (
          <form
            onSubmit={submit}
            className="w-full mb-lg bg-surface-container-low border border-outline-variant/40 rounded-xl p-lg flex flex-col gap-md"
          >
            <span className="font-label-caps text-[10px] tracking-[0.15em] uppercase text-on-surface-variant">
              {editingId ? 'Edit scene' : 'New scene'}
            </span>

            <div className="flex flex-col sm:flex-row gap-sm">
              <label className="flex flex-col gap-xs w-full sm:w-24">
                <span className="text-[11px] text-on-surface-variant">Number</span>
                <input
                  id="scene-number"
                  required
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  placeholder="01"
                  className="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary"
                />
              </label>
              <label className="flex flex-col gap-xs flex-1">
                <span className="text-[11px] text-on-surface-variant">Location</span>
                <input
                  id="scene-title"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="bar"
                  className="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-sm text-on-surface outline-none focus:border-primary"
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-lg">
              <div className="flex flex-col gap-xs">
                <span className="text-[11px] text-on-surface-variant">Interior or exterior</span>
                <div className="flex gap-xs">
                  {SETTINGS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setSetting(option)}
                      className={`px-md py-[6px] rounded-lg text-[11px] font-label-caps border transition-colors cursor-pointer ${
                        setting === option
                          ? 'bg-primary text-background border-primary font-bold'
                          : 'bg-surface-container text-on-surface-variant border-outline-variant hover:text-on-surface'
                      }`}
                    >
                      {SETTING_LABELS[option]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-xs">
                <span className="text-[11px] text-on-surface-variant">Time of day</span>
                <div className="flex flex-wrap gap-xs">
                  {TIMES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setTimeOfDay(option)}
                      className={`px-md py-[6px] rounded-lg text-[11px] font-label-caps border transition-colors cursor-pointer ${
                        timeOfDay === option
                          ? 'bg-primary text-background border-primary font-bold'
                          : 'bg-surface-container text-on-surface-variant border-outline-variant hover:text-on-surface'
                      }`}
                    >
                      {TIME_LABELS[option]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-sm">
              <button
                type="submit"
                className="px-lg py-sm rounded-lg bg-primary text-background font-label-caps text-[11px] tracking-wider font-bold hover:brightness-110 cursor-pointer"
              >
                {editingId ? 'SAVE SCENE' : 'ADD SCENE'}
              </button>
              <button
                type="button"
                onClick={cancel}
                className="px-md py-sm rounded-lg text-on-surface-variant hover:text-on-surface text-[11px] font-label-caps tracking-wider cursor-pointer"
              >
                CANCEL
              </button>
            </div>
          </form>
        )}

        <div className="w-full flex flex-col gap-xs">
          {scenes.length === 0 && !formOpen && (
            <div className="text-center py-xl text-on-surface-variant text-sm">
              No scenes yet. Add the first one — for example <span className="text-on-surface">01 · EXT. BAR — DAY</span>.
            </div>
          )}

          {scenes.map((scene) => {
            const takes = (scene.cameraTakes || []).length;
            const actors = (scene.characters || []).length;
            const props = (scene.scenes || []).length;
            return (
              <div
                key={scene.id}
                className="group flex items-center gap-md bg-surface-container-low hover:bg-surface-container border border-outline-variant/40 hover:border-primary/40 rounded-xl px-lg py-md transition-colors"
              >
                <button
                  onClick={() => onOpenScene(scene.id)}
                  className="flex-1 flex items-center gap-md text-left cursor-pointer min-w-0"
                  title="Open this scene"
                >
                  <span className="font-display-lg text-2xl text-primary/70 group-hover:text-primary font-light w-14 shrink-0 tabular-nums">
                    {scene.number}
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="font-label-caps text-[13px] tracking-wider text-on-surface truncate">
                      {sluglineFor(scene)}
                    </span>
                    <span className="text-[11px] text-on-surface-variant">
                      {props} object{props === 1 ? '' : 's'} · {actors} actor{actors === 1 ? '' : 's'} · {takes} take
                      {takes === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>

                <button
                  onClick={() => startEdit(scene)}
                  className="text-on-surface-variant hover:text-primary p-xs rounded cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Edit slugline"
                >
                  <span className="material-symbols-outlined text-[18px]">edit</span>
                </button>
                <button
                  onClick={() => remove(scene)}
                  className="text-on-surface-variant hover:text-red-400 p-xs rounded cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete scene"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant group-hover:text-primary">
                  arrow_forward
                </span>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
};
