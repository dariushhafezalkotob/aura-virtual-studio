import React from 'react';
import { CameraKeyframe, CameraKeyHandle, CameraTake } from '../../types';
import { EASY_EASE_HANDLE, LINEAR_HANDLE, effectiveKeyHandles } from '../../services/cameraAnimation';

/**
 * The selected key's values, as a panel of its own in the corner of the screen.
 *
 * It used to live down the side of the timeline, which made that card tall enough to push into
 * the viewport - and the viewport is the thing you are actually looking at while framing a shot.
 * Floated off on its own it takes no height from the timeline at all.
 */

interface KeyInspectorProps {
  take: CameraTake;
  selectedKey: CameraKeyframe | null;
  keyIndex: number;
  onChangeKey: (time: number, change: Partial<CameraKeyframe>) => void;
  onMoveKey: (time: number, newTime: number) => void;
  onDeleteKey: (time: number) => void;
  onSetKey: () => void;
  onRetakeKey: (time: number) => void;
  onGoToKey: (direction: 1 | -1) => void;
  onTensionChange: (tension: number) => void;
  /** The lens set, so a key's field of view reads as a lens (135mm) rather than a bare angle (15). */
  lenses: { label: string; fov: number }[];
}

/**
 * Easing presets for THIS key only, as in After Effects' keyframe assistant: each one sets the
 * key's own in and/or out handle and never touches a neighbour. Fine shaping is done by dragging
 * the handles on the graph.
 */
type KeyPreset = 'linear' | 'easy' | 'in' | 'out' | 'hold';

const KEY_PRESETS: { value: KeyPreset; label: string; hint: string }[] = [
  { value: 'linear', label: 'Linear', hint: 'Passes through this key at a constant pace' },
  { value: 'easy', label: 'Easy Ease', hint: 'Eases into and out of this key, coming gently to a stop here' },
  { value: 'in', label: 'Ease In', hint: 'Arrives at this key slowly; leaving is unchanged' },
  { value: 'out', label: 'Ease Out', hint: 'Leaves this key slowly; arriving is unchanged' },
  { value: 'hold', label: 'Hold', hint: 'Waits at this key, then cuts to the next' },
];

const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

function presetChange(preset: KeyPreset, handleIn: CameraKeyHandle, handleOut: CameraKeyHandle): Partial<CameraKeyframe> {
  switch (preset) {
    case 'linear': return { handleIn: { ...LINEAR_HANDLE }, handleOut: { ...LINEAR_HANDLE }, handleMode: 'smooth', ease: undefined };
    case 'easy': return { handleIn: { ...EASY_EASE_HANDLE }, handleOut: { ...EASY_EASE_HANDLE }, handleMode: 'smooth', ease: undefined };
    case 'in': return { handleIn: { ...EASY_EASE_HANDLE }, handleOut, handleMode: near(handleOut.slope, 0) ? 'smooth' : 'broken', ease: undefined };
    case 'out': return { handleIn, handleOut: { ...EASY_EASE_HANDLE }, handleMode: near(handleIn.slope, 0) ? 'smooth' : 'broken', ease: undefined };
    case 'hold': return { handleIn, handleOut, ease: 'hold' };
  }
}

function activePreset(key: CameraKeyframe, handleIn: CameraKeyHandle, handleOut: CameraKeyHandle): KeyPreset | null {
  if (key.ease === 'hold') return 'hold';
  const inEased = near(handleIn.slope, 0);
  const outEased = near(handleOut.slope, 0);
  if (inEased && outEased) return 'easy';
  if (near(handleIn.slope, 1) && near(handleOut.slope, 1)) return 'linear';
  if (inEased) return 'in';
  if (outEased) return 'out';
  return null;
}

/** One compact labelled number, so five channels fit in a small panel. */
const NumberField: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  prefix?: string;
  suffix?: string;
  title?: string;
}> = ({ label, value, onChange, step = 1, min, max, prefix, suffix, title }) => (
  <label className="flex items-center gap-1 text-[9px] text-on-surface-variant" title={title}>
    <span className="w-8 shrink-0 font-label-caps">{label}</span>
    <span className="flex-1 flex items-center gap-0.5 bg-surface-container-lowest border border-outline-variant/40 rounded px-1 focus-within:border-primary">
      {prefix && <span className="text-on-surface-variant">{prefix}</span>}
      <input
        type="number"
        value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="w-full bg-transparent py-0.5 text-[10px] font-mono text-on-surface text-right outline-none"
      />
      {suffix && <span className="text-on-surface-variant">{suffix}</span>}
    </span>
  </label>
);

export const KeyInspector: React.FC<KeyInspectorProps> = ({
  take,
  selectedKey,
  keyIndex,
  onChangeKey,
  onMoveKey,
  onDeleteKey,
  onSetKey,
  onRetakeKey,
  onGoToKey,
  onTensionChange,
  lenses,
}) => {
  const keyHandles = selectedKey && keyIndex >= 0 ? effectiveKeyHandles(take.keyframes, keyIndex) : null;
  const currentPreset = selectedKey && keyHandles ? activePreset(selectedKey, keyHandles.handleIn, keyHandles.handleOut) : null;
  const handleMode = selectedKey?.handleMode || 'smooth';
  const keyLens =
    selectedKey?.fov !== undefined && lenses.length > 0
      ? lenses.reduce((best, l) => (Math.abs(l.fov - selectedKey.fov!) < Math.abs(best.fov - selectedKey.fov!) ? l : best))
      : null;

  return (
    <div className="w-[208px] bg-surface-container/95 border border-outline-variant/40 rounded-xl backdrop-blur-xl shadow-2xl overflow-hidden pointer-events-auto">
      <div className="px-2 py-1.5 flex items-center gap-1 border-b border-outline-variant/25">
        <span className="text-[10px] font-label-caps tracking-wider text-on-surface truncate flex-1">
          {take.name}
        </span>
        <span className="text-[9px] text-on-surface-variant shrink-0">
          {take.keyframes.length}k · {take.duration.toFixed(1)}s
        </span>
      </div>

      <div className="px-2 py-1.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <button
            onClick={() => onGoToKey(-1)}
            className="h-6 w-6 shrink-0 rounded border border-outline-variant/40 text-on-surface-variant hover:text-primary hover:border-primary transition-colors cursor-pointer flex items-center justify-center"
            title="Jump to the previous key"
          >
            <span className="material-symbols-outlined text-[15px]">first_page</span>
          </button>
          <button
            onClick={onSetKey}
            className="h-6 flex-1 rounded bg-primary text-surface-container-lowest text-[10px] font-label-caps font-bold tracking-wider hover:bg-primary/90 transition-colors cursor-pointer flex items-center justify-center gap-1"
            title="Capture the camera where it is now as a key at the playhead"
          >
            <span className="material-symbols-outlined text-[13px]">vpn_key</span>
            Set Key
          </button>
          <button
            onClick={() => onGoToKey(1)}
            className="h-6 w-6 shrink-0 rounded border border-outline-variant/40 text-on-surface-variant hover:text-primary hover:border-primary transition-colors cursor-pointer flex items-center justify-center"
            title="Jump to the next key"
          >
            <span className="material-symbols-outlined text-[15px]">last_page</span>
          </button>
        </div>

        {!selectedKey ? (
          <p className="text-[9px] text-on-surface-variant leading-snug">
            Click a key on the strip or the curve to edit it.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[9px] font-mono text-primary">KEY {keyIndex + 1}</span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => onRetakeKey(selectedKey.time)}
                  className="px-1.5 py-0.5 rounded text-[9px] font-label-caps border border-outline-variant/40 text-on-surface-variant hover:text-primary hover:border-primary cursor-pointer"
                  title="Replace this key's position with wherever the camera is now"
                >
                  Re-take
                </button>
                <button
                  onClick={() => onDeleteKey(selectedKey.time)}
                  className="p-0.5 rounded hover:bg-red-500/20 text-on-surface-variant hover:text-red-400 cursor-pointer"
                  title="Delete this key"
                >
                  <span className="material-symbols-outlined text-[14px]">delete</span>
                </button>
              </div>
            </div>

            <NumberField label="Time" suffix="s" value={selectedKey.time} step={0.1} min={0}
              onChange={(v) => onMoveKey(selectedKey.time, v)} />
            <label className="flex items-center gap-1 text-[9px] text-on-surface-variant" title="The lens this key is on">
              <span className="w-8 shrink-0 font-label-caps">Lens</span>
              <select
                value={keyLens?.label ?? ''}
                onChange={(e) => {
                  const l = lenses.find((x) => x.label === e.target.value);
                  if (l) onChangeKey(selectedKey.time, { fov: l.fov });
                }}
                className="flex-1 bg-surface-container-lowest border border-outline-variant/40 rounded px-1 py-0.5 text-[10px] font-mono text-on-surface outline-none focus:border-primary cursor-pointer"
              >
                {lenses.map((l) => (
                  <option key={l.label} value={l.label}>{l.label}</option>
                ))}
              </select>
            </label>
            <NumberField label="Roll" suffix="°" value={selectedKey.roll ?? 0} step={1}
              onChange={(v) => onChangeKey(selectedKey.time, { roll: v })} />
            <NumberField label="Focus" suffix="m" value={selectedKey.focusDistance ?? 0} step={0.1} min={0}
              title="0 means this key does not set focus"
              onChange={(v) => onChangeKey(selectedKey.time, { focusDistance: v })} />
            <NumberField label="Iris" prefix="f/" value={selectedKey.aperture ?? 0} step={0.1} min={0}
              title="0 means this key does not set the iris"
              onChange={(v) => onChangeKey(selectedKey.time, { aperture: v })} />

            <div className="grid grid-cols-3 gap-1 pt-0.5">
              {KEY_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => keyHandles && onChangeKey(selectedKey.time, presetChange(p.value, keyHandles.handleIn, keyHandles.handleOut))}
                  title={p.hint}
                  className={`px-1 py-0.5 rounded text-[9px] font-label-caps tracking-wide border transition-colors cursor-pointer truncate ${
                    currentPreset === p.value
                      ? 'bg-primary/20 border-primary text-primary'
                      : 'bg-transparent border-outline-variant/40 text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              {/* In After Effects terms: continuous vs broken handles. */}
              <button
                onClick={() => keyHandles && onChangeKey(selectedKey.time, handleMode === 'smooth'
                  ? { handleMode: 'broken', handleIn: keyHandles.handleIn, handleOut: keyHandles.handleOut }
                  // Re-joining lines the incoming handle up with the outgoing one.
                  : { handleMode: 'smooth', handleIn: { ...keyHandles.handleIn, slope: keyHandles.handleOut.slope }, handleOut: keyHandles.handleOut })}
                title={handleMode === 'smooth'
                  ? 'Handles move together, so the speed has no corner here. Click to break them (or Alt-drag a handle).'
                  : 'Handles move on their own. Click to join them again.'}
                className="px-1 py-0.5 rounded text-[9px] font-label-caps tracking-wide border transition-colors cursor-pointer truncate bg-transparent border-outline-variant/40 text-on-surface-variant hover:text-on-surface flex items-center justify-center gap-0.5"
              >
                <span className="material-symbols-outlined text-[11px]">{handleMode === 'smooth' ? 'link' : 'link_off'}</span>
                {handleMode === 'smooth' ? 'Smooth' : 'Broken'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="px-2 py-1 border-t border-outline-variant/25 flex items-center gap-1.5">
        <span className="text-[9px] font-label-caps text-on-surface-variant">Path</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={take.tension ?? 0.5}
          onChange={(e) => onTensionChange(Number(e.target.value))}
          className="flex-1 min-w-0 accent-primary cursor-pointer"
          title="0 walks straight between keys; higher rounds the corners into a curve"
        />
        <span className="text-[9px] font-mono text-on-surface w-6 text-right">
          {(take.tension ?? 0.5).toFixed(2)}
        </span>
      </div>
    </div>
  );
};
