import React from 'react';
import { CameraEase, CameraKeyframe, CameraTake } from '../../types';

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
}

const EASE_PRESETS: { value: CameraEase; label: string; hint: string }[] = [
  { value: 'linear', label: 'Linear', hint: 'Constant speed the whole way' },
  { value: 'ease-in', label: 'Ease In', hint: 'Starts slow, arrives at speed' },
  { value: 'ease-out', label: 'Ease Out', hint: 'Leaves at speed, arrives slow' },
  { value: 'ease-in-out', label: 'Smooth', hint: 'Eases out of the start and into the end' },
  { value: 'bezier', label: 'Custom', hint: 'Drag the handles on the curve to shape the timing' },
  { value: 'hold', label: 'Hold', hint: 'Waits here, then cuts to the next key' },
];

export const DEFAULT_HANDLES: [number, number, number, number] = [0.42, 0, 0.58, 1];

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
}) => {
  const ease = selectedKey?.ease || 'linear';

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
            <NumberField label="Lens" suffix="°" value={selectedKey.fov ?? 50} step={1} min={5} max={120}
              onChange={(v) => onChangeKey(selectedKey.time, { fov: v })} />
            <NumberField label="Roll" suffix="°" value={selectedKey.roll ?? 0} step={1}
              onChange={(v) => onChangeKey(selectedKey.time, { roll: v })} />
            <NumberField label="Focus" suffix="m" value={selectedKey.focusDistance ?? 0} step={0.1} min={0}
              title="0 means this key does not set focus"
              onChange={(v) => onChangeKey(selectedKey.time, { focusDistance: v })} />
            <NumberField label="Iris" prefix="f/" value={selectedKey.aperture ?? 0} step={0.1} min={0}
              title="0 means this key does not set the iris"
              onChange={(v) => onChangeKey(selectedKey.time, { aperture: v })} />

            <div className="grid grid-cols-3 gap-1 pt-0.5">
              {EASE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() =>
                    onChangeKey(selectedKey.time, {
                      ease: p.value,
                      easeHandles: p.value === 'bezier' ? (selectedKey.easeHandles || DEFAULT_HANDLES) : undefined,
                    })
                  }
                  title={p.hint}
                  className={`px-1 py-0.5 rounded text-[9px] font-label-caps tracking-wide border transition-colors cursor-pointer truncate ${
                    ease === p.value
                      ? 'bg-primary/20 border-primary text-primary'
                      : 'bg-transparent border-outline-variant/40 text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {p.label}
                </button>
              ))}
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
