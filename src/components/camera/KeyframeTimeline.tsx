import React, { useCallback, useMemo, useRef, useState } from 'react';
import { CameraKeyframe, CameraKeyHandle, CameraTake } from '../../types';
import { MAX_HANDLE_SLOPE, effectiveKeyHandles, segmentProgress } from '../../services/cameraAnimation';

/**
 * A timeline of camera keys, with the move's timing curve underneath it.
 *
 * Two halves, because they answer two different questions: the strip says WHEN things happen and
 * the curve says HOW the move travels between them.
 *
 * The curve is drawn by sampling the same `segmentProgress` that plays the move, rather than by
 * drawing a bezier that approximates it. A curve editor that shows something subtly different
 * from what the camera does is worse than no curve editor at all.
 *
 * Handles belong to keys, as in After Effects: the selected key shows how the move arrives (in)
 * and leaves (out), and dragging one shapes the curve at that key only. A smooth key turns both
 * handles together; Alt-drag breaks them apart.
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




/** Progress range the graph shows: the move runs 0..1, with room around it for overshoot. */
const V_MIN = -0.25;
const V_MAX = 1.25;

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
  // Short by default so the viewport keeps its height; taller when shaping handles in detail.
  const [tallGraph, setTallGraph] = useState(false);

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

  const ticks = useMemo(() => {
    // A tick roughly every second, thinned out on long moves so the ruler stays readable.
    const step = span <= 6 ? 1 : span <= 15 ? 2 : 5;
    const out: number[] = [];
    for (let t = 0; t <= span; t += step) out.push(Number(t.toFixed(2)));
    return out;
  }, [span]);




  /**
   * The whole move as one curve: time across, progress along the move up, every key at its own
   * time fraction (so a constant pace is a straight diagonal). The vertical range leaves room
   * above and below for overshoot and anticipation curves.
   */
  const first = keys.length ? keys[0].time : 0;
  const total = keys.length > 1 ? Math.max(1e-6, keys[keys.length - 1].time - first) : 1;
  const progressOf = (t: number) => (t - first) / total;
  const xPct = (t: number) => (t / span) * 100;
  const yPct = (v: number) => (1 - (v - V_MIN) / (V_MAX - V_MIN)) * 100;

  const { curve, anchors } = useMemo(() => {
    if (keys.length < 2) return { curve: '', anchors: [] as { x: number; y: number; time: number }[] };
    const pts: string[] = [];
    const anchorPts: { x: number; y: number; time: number }[] = [];
    for (let i = 0; i < keys.length - 1; i++) {
      const k0 = keys[i];
      const k1 = keys[i + 1];
      const v0 = progressOf(k0.time);
      const v1 = progressOf(k1.time);
      anchorPts.push({ x: xPct(k0.time), y: yPct(v0), time: k0.time });
      const STEPS = 48;
      for (let sIdx = 0; sIdx <= STEPS; sIdx++) {
        const local = sIdx / STEPS;
        const v = v0 + (v1 - v0) * segmentProgress(k0, k1, local);
        const t = k0.time + (k1.time - k0.time) * local;
        pts.push(`${xPct(t).toFixed(2)},${yPct(v).toFixed(2)}`);
      }
    }
    const kLast = keys[keys.length - 1];
    anchorPts.push({ x: xPct(kLast.time), y: yPct(1), time: kLast.time });
    return { curve: `M ${pts.join(' L ')}`, anchors: anchorPts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, span]);

  /** Where the selected key's two handles sit on the graph, in the same % space as the curve. */
  const handleGeometry = useMemo(() => {
    if (selectedIndex < 0 || keys.length < 2) return null;
    const k = keys[selectedIndex];
    const { handleIn, handleOut } = effectiveKeyHandles(keys, selectedIndex);
    const v = progressOf(k.time);
    const prev = selectedIndex > 0 ? keys[selectedIndex - 1] : null;
    const next = selectedIndex < keys.length - 1 ? keys[selectedIndex + 1] : null;
    const anchor = { x: xPct(k.time), y: yPct(v) };
    const inPt = prev
      ? (() => {
          const dt = k.time - prev.time;
          const dv = v - progressOf(prev.time);
          return { x: xPct(k.time - handleIn.influence * dt), y: yPct(v - handleIn.influence * handleIn.slope * dv) };
        })()
      : null;
    const outPt = next && k.ease !== 'hold'
      ? (() => {
          const dt = next.time - k.time;
          const dv = progressOf(next.time) - v;
          return { x: xPct(k.time + handleOut.influence * dt), y: yPct(v + handleOut.influence * handleOut.slope * dv) };
        })()
      : null;
    return { anchor, inPt, outPt, handleIn, handleOut, prev, next };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, selectedIndex, span]);

  /** Dragging one of the selected key's handles. Only this key changes. */
  const grabHandle = (side: 'in' | 'out') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const box = curveRef.current;
    const g = handleGeometry;
    if (!box || !g || !selectedKey) return;
    const neighbour = side === 'in' ? g.prev : g.next;
    if (!neighbour) return;
    const key = selectedKey;
    const v = progressOf(key.time);
    const dt = Math.abs(key.time - neighbour.time);
    const dv = Math.abs(v - progressOf(neighbour.time));
    // Alt (Option) breaks the handles apart, as in After Effects; otherwise keep the key's mode.
    const mode: 'smooth' | 'broken' = e.altKey ? 'broken' : key.handleMode || 'smooth';
    const startIn = g.handleIn;
    const startOut = g.handleOut;

    const move = (ev: PointerEvent) => {
      // Measured off the curve box itself, so a change of height cannot put handles out of step.
      const rect = box.getBoundingClientRect();
      const tAt = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * span;
      const vAt = V_MAX - ((ev.clientY - rect.top) / Math.max(1, rect.height)) * (V_MAX - V_MIN);
      const dir = side === 'out' ? 1 : -1;
      const influence = Math.max(0.02, Math.min(1, (dir * (tAt - key.time)) / Math.max(1e-6, dt)));
      const rise = (dir * (vAt - v)) / Math.max(1e-6, dv);
      const slope = Math.max(-MAX_HANDLE_SLOPE, Math.min(MAX_HANDLE_SLOPE, rise / influence));
      const moved: CameraKeyHandle = { slope: Number(slope.toFixed(3)), influence: Number(influence.toFixed(3)) };
      // Smooth: the other handle turns with this one (same slope, its own reach), so the speed
      // has no corner at this key.
      const other = side === 'out' ? startIn : startOut;
      const paired: CameraKeyHandle = mode === 'smooth' ? { slope: moved.slope, influence: other.influence } : other;
      onChangeKey(key.time, side === 'out'
        ? { handleOut: moved, handleIn: paired, handleMode: mode }
        : { handleIn: moved, handleOut: paired, handleMode: mode });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

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
        <div
          ref={curveRef}
          className={`relative border-t border-outline-variant/25 bg-surface-container-lowest/60 ${tallGraph ? 'h-[200px]' : 'h-[88px]'}`}
        >
          {keys.length < 2 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-[10px] text-on-surface-variant">Set a second key to shape the move.</p>
            </div>
          ) : (
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              {/* Start and end of the move, so overshoot reads as going past them. */}
              <line x1="0" y1={yPct(0)} x2="100" y2={yPct(0)} stroke="rgba(255,255,255,0.08)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={yPct(1)} x2="100" y2={yPct(1)} stroke="rgba(255,255,255,0.08)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
              <path d={curve} fill="none" stroke="#e8c45a" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              {handleGeometry?.inPt && (
                <line x1={handleGeometry.anchor.x} y1={handleGeometry.anchor.y} x2={handleGeometry.inPt.x} y2={handleGeometry.inPt.y}
                  stroke="#7dd3fc" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
              )}
              {handleGeometry?.outPt && (
                <line x1={handleGeometry.anchor.x} y1={handleGeometry.anchor.y} x2={handleGeometry.outPt.x} y2={handleGeometry.outPt.y}
                  stroke="#7dd3fc" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
          )}

          {keys.length >= 2 && (
            <button
              type="button"
              onClick={() => setTallGraph((v) => !v)}
              className="absolute right-1 top-1 z-10 p-0.5 rounded text-on-surface-variant hover:text-primary bg-surface-container/80 cursor-pointer"
              title={tallGraph ? 'Make the graph shorter' : 'Make the graph taller for shaping handles'}
            >
              <span className="material-symbols-outlined text-[14px]">{tallGraph ? 'unfold_less' : 'unfold_more'}</span>
            </button>
          )}

          {/* Anchors as real elements, so the stretched viewBox cannot squash the squares. */}
          {keys.length >= 2 &&
            anchors.map((a) => (
              <div
                key={a.time}
                onPointerDown={(e) => { e.stopPropagation(); onSelectKey(a.time); }}
                className={`absolute w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-colors ${
                  a.time === selectedKeyTime ? 'bg-[#e8c45a] ring-2 ring-white' : 'bg-[#e8c45a]/80'
                }`}
                style={{ left: `${a.x}%`, top: `${a.y}%` }}
                title={`Key at ${a.time.toFixed(2)}s`}
              />
            ))}

          {handleGeometry && (['in', 'out'] as const).map((side) => {
            const pt = side === 'in' ? handleGeometry.inPt : handleGeometry.outPt;
            if (!pt) return null;
            const h = side === 'in' ? handleGeometry.handleIn : handleGeometry.handleOut;
            return (
              <div
                key={side}
                onPointerDown={grabHandle(side)}
                className="absolute w-2.5 h-2.5 rounded-full bg-[#7dd3fc] -translate-x-1/2 -translate-y-1/2 cursor-grab ring-2 ring-surface-container"
                style={{ left: `${pt.x}%`, top: `${pt.y}%` }}
                title={`${side === 'in' ? 'How the move arrives at this key' : 'How the move leaves this key'}: speed ${h.slope.toFixed(2)}x, reach ${Math.round(h.influence * 100)}%. Alt-drag to move it on its own.`}
              />
            );
          })}
        </div>

        {/* One playhead down both layers, so time reads straight through the panel. */}
        <div className="absolute top-3 bottom-0 w-px bg-red-400 pointer-events-none" style={{ left: toPercent(currentTime) }}>
          <div className="w-1.5 h-1.5 -ml-[2.5px] rounded-full bg-red-400 shadow-[0_0_6px_#f87171]" />
        </div>
      </div>

    </div>
  );
};
