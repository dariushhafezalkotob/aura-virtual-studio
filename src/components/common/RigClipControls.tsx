import React from 'react';
import type { RigClipSettings, SceneAsset } from '../../types';

/**
 * Which of an imported model's own animations plays, and when. Shown on Scene Design's object
 * inspector and in Acting's object panel, where the timing is actually judged against the scene.
 */
export const RigClipControls: React.FC<{
  asset: SceneAsset;
  onChange: (rigClip: RigClipSettings | undefined) => void;
  /** Smaller type for the Acting panel. */
  compact?: boolean;
}> = ({ asset, onChange, compact = false }) => {
  const clips = asset.animationClips || [];
  if (clips.length === 0) return null;
  const current = asset.rigClip;
  const set = (patch: Partial<RigClipSettings>) =>
    onChange({ index: 0, loop: true, start: 0, speed: 1, ...current, ...patch });
  const text = compact ? 'text-[10px]' : 'text-[11px]';

  return (
    <div className={`flex flex-col gap-1.5 ${text} text-on-surface-variant`}>
      <label className="flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[14px] text-amber-400">directions_run</span>
        <span className="shrink-0">Animation</span>
        <select
          value={current ? String(current.index) : ''}
          onChange={(e) => (e.target.value === '' ? onChange(undefined) : set({ index: Number(e.target.value) }))}
          className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant/40 rounded px-1 py-0.5 text-on-surface outline-none focus:border-amber-400 cursor-pointer"
          title="One of the animations that came inside the model file"
        >
          <option value="">None (rest pose)</option>
          {clips.map((c, i) => (
            <option key={i} value={i}>
              {c.name} · {c.duration.toFixed(1)} s
            </option>
          ))}
        </select>
      </label>
      {current && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1 cursor-pointer" title="Repeat for as long as the scene runs; off plays once and holds the last frame">
            <input type="checkbox" checked={current.loop} onChange={(e) => set({ loop: e.target.checked })} className="accent-amber-400 cursor-pointer" />
            Loop
          </label>
          <label className="flex items-center gap-1" title="Scene time when the animation starts; before that it holds its first frame">
            Start
            <input
              type="number"
              min={0}
              step={0.1}
              value={current.start}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) set({ start: v });
              }}
              className="w-14 bg-surface-container-lowest border border-outline-variant/40 rounded px-1 py-0.5 font-mono text-on-surface text-right outline-none focus:border-amber-400"
            />
            s
          </label>
          <label className="flex items-center gap-1" title="1 plays it as authored; 0.5 is half speed">
            Speed
            <input
              type="number"
              min={0.1}
              max={4}
              step={0.1}
              value={current.speed}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) set({ speed: v });
              }}
              className="w-12 bg-surface-container-lowest border border-outline-variant/40 rounded px-1 py-0.5 font-mono text-on-surface text-right outline-none focus:border-amber-400"
            />
            ×
          </label>
        </div>
      )}
    </div>
  );
};
