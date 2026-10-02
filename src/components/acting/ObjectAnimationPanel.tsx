import React from 'react';
import type { ObjectKeyframe, SceneAsset } from '../../types';
import { keyAt } from '../../services/objectAnimation';

/**
 * Keys for one set object - a car that drives through the shot.
 *
 * The object is moved with the same gizmo as on Scene Design. Until it has a key that changes
 * where it stands in the set; once it has one, every move is keyed at the playhead instead, so
 * the route is built by "move the playhead, move the car".
 */

interface ObjectAnimationPanelProps {
  asset: SceneAsset;
  timelineSec: number;
  onSetKey: () => void;
  onDeleteKey: (time: number) => void;
  onGoToKey: (direction: 1 | -1) => void;
  onChangeKey: (time: number, change: Partial<ObjectKeyframe>) => void;
  onMoveKey: (time: number, newTime: number) => void;
  onToggleAutoFace: (on: boolean) => void;
  onClearAnimation: () => void;
  onClose: () => void;
}

const EASES: { value: NonNullable<ObjectKeyframe['ease']>; label: string; hint: string }[] = [
  { value: 'linear', label: 'Pass', hint: 'Passes through this key without slowing down' },
  { value: 'ease', label: 'Ease', hint: 'Slows to a stop at this key and pulls away again' },
  { value: 'hold', label: 'Hold', hint: 'Waits here, then jumps to the next key' },
];

export const ObjectAnimationPanel: React.FC<ObjectAnimationPanelProps> = ({
  asset,
  timelineSec,
  onSetKey,
  onDeleteKey,
  onGoToKey,
  onChangeKey,
  onMoveKey,
  onToggleAutoFace,
  onClearAnimation,
  onClose,
}) => {
  const keys = asset.animation?.keys || [];
  const current = keyAt(asset.animation, timelineSec);
  const index = current ? keys.indexOf(current) : -1;

  return (
    <div className="w-60 bg-surface-container/95 border border-outline-variant/40 rounded-xl backdrop-blur-xl shadow-2xl overflow-hidden pointer-events-auto">
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-b border-outline-variant/25">
        <span className="material-symbols-outlined text-[15px] text-amber-400">directions_car</span>
        <span className="text-[10px] font-label-caps tracking-wider text-on-surface truncate flex-1" title={asset.name}>
          {asset.name}
        </span>
        <span className="text-[9px] text-on-surface-variant shrink-0">{keys.length} {keys.length === 1 ? 'key' : 'keys'}</span>
        <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface text-[12px] cursor-pointer" title="Deselect">
          ✕
        </button>
      </div>

      <div className="px-2.5 py-2 flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => onGoToKey(-1)}
            disabled={keys.length === 0}
            className="h-7 w-7 shrink-0 rounded border border-outline-variant/40 text-on-surface-variant hover:text-amber-300 hover:border-amber-400 disabled:opacity-30 transition-colors cursor-pointer flex items-center justify-center"
            title="Jump to the previous key"
          >
            <span className="material-symbols-outlined text-[16px]">first_page</span>
          </button>
          <button
            onClick={onSetKey}
            className="h-7 flex-1 rounded bg-amber-400 text-black text-[10px] font-label-caps font-bold tracking-wider hover:bg-amber-300 transition-colors cursor-pointer flex items-center justify-center gap-1"
            title="Key where the object is now, at the playhead"
          >
            <span className="material-symbols-outlined text-[14px]">vpn_key</span>
            {current ? 'Re-key' : 'Set Key'} @ {timelineSec.toFixed(2)}s
          </button>
          <button
            onClick={() => onGoToKey(1)}
            disabled={keys.length === 0}
            className="h-7 w-7 shrink-0 rounded border border-outline-variant/40 text-on-surface-variant hover:text-amber-300 hover:border-amber-400 disabled:opacity-30 transition-colors cursor-pointer flex items-center justify-center"
            title="Jump to the next key"
          >
            <span className="material-symbols-outlined text-[16px]">last_page</span>
          </button>
        </div>

        {keys.length === 0 ? (
          <p className="text-[10px] text-on-surface-variant leading-snug">
            Put the playhead where the move starts and press Set Key. Then move the playhead, move the object, and it is
            keyed there. Until the first key, moving it changes where it stands in the set.
          </p>
        ) : !current ? (
          <p className="text-[10px] text-on-surface-variant leading-snug">
            Between keys. Move the object to key it here, or jump to a key to edit it.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-mono text-amber-300">KEY {index + 1} of {keys.length}</span>
              <button
                onClick={() => onDeleteKey(current.time)}
                className="p-0.5 rounded hover:bg-red-500/20 text-on-surface-variant hover:text-red-400 cursor-pointer"
                title="Delete this key"
              >
                <span className="material-symbols-outlined text-[15px]">delete</span>
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-[10px] text-on-surface-variant" title="When the object is at this key. A later time makes the scene longer.">
              <span className="w-8 shrink-0 font-label-caps">Time</span>
              <span className="flex-1 flex items-center gap-0.5 bg-surface-container-lowest border border-outline-variant/40 rounded px-1 focus-within:border-amber-400">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={Number(current.time.toFixed(3))}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0) onMoveKey(current.time, v);
                  }}
                  className="w-full bg-transparent py-0.5 text-[11px] font-mono text-on-surface text-right outline-none"
                />
                <span>s</span>
              </span>
            </label>
            <div className="grid grid-cols-3 gap-1">
              {EASES.map((e) => (
                <button
                  key={e.value}
                  onClick={() => onChangeKey(current.time, { ease: e.value })}
                  title={e.hint}
                  className={`px-1 py-1 rounded text-[10px] font-label-caps tracking-wide border transition-colors cursor-pointer ${
                    (current.ease || 'linear') === e.value
                      ? 'bg-amber-400/20 border-amber-400 text-amber-300'
                      : 'bg-transparent border-outline-variant/40 text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </>
        )}

        {keys.length > 0 && (
          <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-outline-variant/20">
            <label
              className="flex items-center gap-1.5 text-[10px] text-on-surface-variant cursor-pointer"
              title="Turns the object with its route. Aim it along the route at the first key; it follows every bend after that."
            >
              <input
                type="checkbox"
                checked={!!asset.animation?.autoFace}
                onChange={(e) => onToggleAutoFace(e.target.checked)}
                className="accent-amber-400 cursor-pointer"
              />
              Turn with the route
            </label>
            <button
              onClick={onClearAnimation}
              className="text-[9px] font-label-caps text-on-surface-variant hover:text-red-400 cursor-pointer"
              title="Delete every key. The object goes back to where it stands in the set."
            >
              Clear all
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
