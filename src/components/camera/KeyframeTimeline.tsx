import React, { useCallback, useMemo, useRef, useState } from 'react';
import { CameraKeyframe, CameraTake } from '../../types';
import { applyEase } from '../../services/cameraAnimation';
import { DEFAULT_HANDLES } from './KeyInspector';

/**
 * A timeline of camera keys, with the easing curve for the selected key underneath it.
 *
 * Two halves, because they answer two different questions: the strip says WHEN things happen and
 * the curve says HOW the move gets from this key to the next.
 *
 * The curve is drawn by sampling the same `applyEase` that plays the move, rather than by drawing
 * a bezier that approximates it. A curve editor that shows something subtly different from what
 * the camera does is worse than no curve editor at all.
 */

interface KeyframeTimelineProps {
  take: CameraTake;
  currentTime: number;
  selectedKeyTime: number | null;
  onSelectKey: (time: number | null) => void;
  onMoveKey: (time: number, newTime: number) => void;
  onChangeKey: (time: number, change: Partial<CameraKeyframe>) => void;
  onScrub: (time: number) => void;
}




export const KeyframeTimeline: React.FC<KeyframeTimelineProps> = ({
  take,
  currentTime,
  selectedKeyTime,
  onSelectKey,
  onMoveKey,
  onChangeKey,
  onScrub,
}) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const curveRef = useRef<HTMLDivElement>(null);
  const [dragKeyTime, setDragKeyTime] = useState<number | null>(null);

  const keys = take.keyframes;
  // Always show a little past the last key, so there is room to drop the next one.
  const span = Math.max(take.duration, keys.length ? keys[keys.length - 1].time : 0, 1) * 1.05;

  const toPercent = useCallback((t: number) => `${Math.min(100, Math.max(0, (t / span) * 100))}%`, [span]);

  const timeFromEvent = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = (clientX - rect.left) / Math.max(1, rect.width);
      return Math.max(0, Number((ratio * span).toFixed(3)));
    },
    [span]
  );

  const selectedKey = useMemo(
    () => keys.find((k) => k.time === selectedKeyTime) || null,
    [keys, selectedKeyTime]
  );
  const selectedIndex = selectedKey ? keys.indexOf(selectedKey) : -1;
  const nextKey = selectedIndex >= 0 && selectedIndex < keys.length - 1 ? keys[selectedIndex + 1] : null;

  // ---- dragging a key along the strip ----
  const beginKeyDrag = (e: React.PointerEvent, keyTime: number) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragKeyTime(keyTime);
    onSelectKey(keyTime);
  };

  const onStripPointerMove = (e: React.PointerEvent) => {
    if (dragKeyTime === null) return;
    const t = timeFromEvent(e.clientX);
    if (Math.abs(t - dragKeyTime) < 1e-4) return;
    onMoveKey(dragKeyTime, t);
    setDragKeyTime(t);
  };

  const endKeyDrag = () => setDragKeyTime(null);

  // ---- the easing curve ----
  const ease = selectedKey?.ease || 'linear';
  const handles = selectedKey?.easeHandles || DEFAULT_HANDLES;

  const ticks = useMemo(() => {
    // A tick roughly every second, thinned out on long moves so the ruler stays readable.
    const step = span <= 6 ? 1 : span <= 15 ? 2 : 5;
    const out: number[] = [];
    for (let t = 0; t <= span; t += step) out.push(Number(t.toFixed(2)));
    return out;
  }, [span]);




  /**
   * The whole move as one curve: time across, progress along the path up.
   *
   * Drawn segment by segment through the same `applyEase` that plays it, so the graph cannot
   * drift from the motion. A key sits at its own fraction of the way along, which is why the
   * anchors are not evenly spaced when the keys are not.
   */
  const { curve, anchors } = useMemo(() => {
    if (keys.length < 2) return { curve: '', anchors: [] as { x: number; y: number; time: number }[] };

    const first = keys[0].time;
    const last = keys[keys.length - 1].time;
    const total = Math.max(1e-6, last - first);
    const pts: string[] = [];
    const anchorPts: { x: number; y: number; time: number }[] = [];

    for (let i = 0; i < keys.length - 1; i++) {
      const k0 = keys[i];
      const k1 = keys[i + 1];
      const y0 = (k0.time - first) / total;
      const y1 = (k1.time - first) / total;
      anchorPts.push({ x: (k0.time / span) * 100, y: 100 - y0 * 100, time: k0.time });

      const STEPS = 24;
      for (let sIdx = 0; sIdx <= STEPS; sIdx++) {
        const local = sIdx / STEPS;
        const eased = applyEase(local, k0.ease, k0.easeHandles);
        const t = k0.time + (k1.time - k0.time) * local;
        const y = y0 + (y1 - y0) * eased;
        pts.push(`${((t / span) * 100).toFixed(2)},${(100 - y * 100).toFixed(2)}`);
      }
    }
    const kLast = keys[keys.length - 1];
    anchorPts.push({ x: (kLast.time / span) * 100, y: 0, time: kLast.time });

    return { curve: `M ${pts.join(' L ')}`, anchors: anchorPts };
  }, [keys, span]);

  return (
    <div className="w-full flex items-stretch">
      {/* ---- left: the two time layers, kept as short as they can be read at ---- */}
      <div
        ref={stripRef}
        className="relative flex-1 min-w-0 select-none"
        onPointerMove={onStripPointerMove}
        onPointerUp={endKeyDrag}
        onPointerLeave={endKeyDrag}
      >
        {/* layer 1: time */}
        <div
          className="relative h-8 cursor-pointer"
          onPointerDown={(e) => { if (dragKeyTime === null) onScrub(timeFromEvent(e.clientX)); }}
        >
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0.5 text-[9px] font-mono text-on-surface-variant -translate-x-1/2"
              style={{ left: toPercent(t) }}
            >
              {t}s
            </div>
          ))}
          <div className="absolute inset-x-0 top-[19px] h-1 rounded-full bg-surface-container-highest" />
          {keys.length > 1 && (
            <div
              className="absolute top-[19px] h-1 rounded-full bg-primary/40"
              style={{
                left: toPercent(keys[0].time),
                width: `calc(${toPercent(keys[keys.length - 1].time)} - ${toPercent(keys[0].time)})`,
              }}
            />
          )}
          {keys.map((k) => {
            const isSel = k.time === selectedKeyTime;
            return (
              <div
                key={k.time}
                onPointerDown={(e) => beginKeyDrag(e, k.time)}
                onDoubleClick={(e) => { e.stopPropagation(); onScrub(k.time); }}
                title={`${k.time.toFixed(2)}s — drag to retime`}
                className="absolute top-[14px] w-2.5 h-2.5 -translate-x-1/2 rotate-45 cursor-ew-resize"
                style={{
                  left: toPercent(k.time),
                  background: isSel ? '#7dd3fc' : '#94a3b8',
                  boxShadow: isSel ? '0 0 7px rgba(125,211,252,0.85)' : 'none',
                  border: isSel ? '1px solid #fff' : '1px solid rgba(255,255,255,0.35)',
                }}
              />
            );
          })}
        </div>

        {/* layer 2: the curve */}
        <div ref={curveRef} className="relative h-[72px] border-t border-outline-variant/25 bg-surface-container-lowest/60">
          {keys.length < 2 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-[10px] text-on-surface-variant">Set a second key to shape the move.</p>
            </div>
          ) : (
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(255,255,255,0.08)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
              <path d={curve} fill="none" stroke="#e8c45a" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          )}

          {/* Anchors as real elements, so the stretched viewBox cannot squash the circles. */}
          {keys.length >= 2 &&
            anchors.map((a) => (
              <div
                key={a.time}
                onPointerDown={(e) => { e.stopPropagation(); onSelectKey(a.time); }}
                className={`absolute w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-colors ${
                  a.time === selectedKeyTime ? 'bg-white ring-2 ring-primary' : 'bg-white/90'
                }`}
                style={{ left: `${a.x}%`, top: `${a.y}%` }}
                title={`Key at ${a.time.toFixed(2)}s`}
              />
            ))}

          {selectedKey && nextKey && ease === 'bezier' && (() => {
            const first = keys[0].time;
            const total = Math.max(1e-6, keys[keys.length - 1].time - first);
            const y0 = (selectedKey.time - first) / total;
            const y1 = (nextKey.time - first) / total;
            const segT = nextKey.time - selectedKey.time;

            const handlePos = (hx: number, hy: number) => ({
              left: `${(((selectedKey.time + segT * hx) / span) * 100).toFixed(2)}%`,
              top: `${(100 - (y0 + (y1 - y0) * hy) * 100).toFixed(2)}%`,
            });

            const grab = (which: 'out' | 'in') => (e: React.PointerEvent<HTMLDivElement>) => {
              e.stopPropagation();
              const box = curveRef.current;
              if (!box) return;
              const move = (ev: PointerEvent) => {
                // Measured off the curve box itself, so changing either layer's height cannot
                // silently put the handles out of step with the curve.
                const rect = box.getBoundingClientRect();
                const tAt = ((ev.clientX - rect.left) / rect.width) * span;
                const x = Math.max(0, Math.min(1, (tAt - selectedKey.time) / Math.max(1e-6, segT)));
                const yFrac = 1 - (ev.clientY - rect.top) / Math.max(1, rect.height);
                const yLocal = (yFrac - y0) / Math.max(1e-6, y1 - y0);
                const y = Math.max(-0.5, Math.min(1.5, yLocal));
                const next: [number, number, number, number] = [...handles] as any;
                if (which === 'out') { next[0] = x; next[1] = y; } else { next[2] = x; next[3] = y; }
                onChangeKey(selectedKey.time, { ease: 'bezier', easeHandles: next });
              };
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            };

            return (
              <>
                <div
                  onPointerDown={grab('out')}
                  className="absolute w-2.5 h-2.5 rounded-full bg-primary -translate-x-1/2 -translate-y-1/2 cursor-grab ring-2 ring-surface-container"
                  style={handlePos(handles[0], handles[1])}
                  title="Shapes how the move leaves this key"
                />
                <div
                  onPointerDown={grab('in')}
                  className="absolute w-2.5 h-2.5 rounded-full bg-primary -translate-x-1/2 -translate-y-1/2 cursor-grab ring-2 ring-surface-container"
                  style={handlePos(handles[2], handles[3])}
                  title="Shapes how the move arrives at the next key"
                />
              </>
            );
          })()}
        </div>

        {/* One playhead down both layers, so time reads straight through the panel. */}
        <div className="absolute top-3 bottom-0 w-px bg-red-400 pointer-events-none" style={{ left: toPercent(currentTime) }}>
          <div className="w-1.5 h-1.5 -ml-[2.5px] rounded-full bg-red-400 shadow-[0_0_6px_#f87171]" />
        </div>
      </div>

    </div>
  );
};
