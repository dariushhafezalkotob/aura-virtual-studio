import React, { useRef, useState, useCallback, useEffect } from 'react';
import { CharacterActor, WorkflowStage } from '../../types';

interface MultiActorTimelineProps {
  characters: CharacterActor[];
  selectedActorId: string;
  timelineSec: number;
  maxDuration: number;
  isPlaying: boolean;
  playbackSpeed: number;
  onSelectActor: (id: string) => void;
  onSeek: (timeSec: number) => void;
  onTogglePlay: () => void;
  onResetTime: () => void;
  onChangePlaybackSpeed: (speed: number) => void;
  onAddActor?: (type: 'soma' | 'g1') => void;
  onNavigateStage?: (stage: WorkflowStage) => void;
  onUpdateActorProps?: (actorId: string, updates: Partial<CharacterActor>) => void;
}

const PRESET_ACTOR_COLORS = [
  '#00ffcc', '#af52de', '#ff9500', '#ff2d55', '#34c759',
  '#007aff', '#ffd60a', '#ff375f', '#32363d', '#e5e5ea',
];

const PRESET_AVATARS = ['🏃', '🤖', '🥷', '🦸', '💃', '🧟', '👤', '🦾'];

const CONSTRAINT_COLOR_MAP: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  destination: { bg: 'bg-purple-600/30', border: 'border-purple-500/60', text: 'text-purple-300', icon: 'pin_drop' },
  upper_body_lock: { bg: 'bg-amber-600/30', border: 'border-amber-500/60', text: 'text-amber-300', icon: 'accessibility_new' },
  look_at: { bg: 'bg-cyan-600/30', border: 'border-cyan-500/60', text: 'text-cyan-300', icon: 'visibility' },
  facing_direction: { bg: 'bg-blue-600/30', border: 'border-blue-500/60', text: 'text-blue-300', icon: 'explore' },
  foot_grounding: { bg: 'bg-emerald-600/30', border: 'border-emerald-500/60', text: 'text-emerald-300', icon: 'do_not_step' },
  stance_height: { bg: 'bg-rose-600/30', border: 'border-rose-500/60', text: 'text-rose-300', icon: 'height' },
};

export const MultiActorTimeline: React.FC<MultiActorTimelineProps> = ({
  characters,
  selectedActorId,
  timelineSec,
  maxDuration,
  isPlaying,
  playbackSpeed,
  onSelectActor,
  onSeek,
  onTogglePlay,
  onResetTime,
  onChangePlaybackSpeed,
  onAddActor,
  onNavigateStage,
  onUpdateActorProps,
}) => {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [editingActorId, setEditingActorId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [activeColorPickerActorId, setActiveColorPickerActorId] = useState<string | null>(null);
  const [activeAvatarPickerActorId, setActiveAvatarPickerActorId] = useState<string | null>(null);

  // Time ruler ticks (e.g. 0s, 1s, 2s, 3s...)
  const totalSeconds = Math.max(4, Math.ceil(maxDuration));
  const tickMarks = Array.from({ length: totalSeconds + 1 }, (_, i) => i);

  // Playhead percentage
  const playheadPercent = Math.min(100, Math.max(0, (timelineSec / maxDuration) * 100));

  // Compute time from mouse event on timeline lanes
  const handleSeekFromEvent = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      if (!rulerRef.current) return;
      const rect = rulerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const fraction = Math.min(1, Math.max(0, clickX / rect.width));
      onSeek(fraction * maxDuration);
    },
    [maxDuration, onSeek]
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsScrubbing(true);
    handleSeekFromEvent(e);
  };

  useEffect(() => {
    if (!isScrubbing) return;

    const handleMouseMove = (e: MouseEvent) => {
      handleSeekFromEvent(e);
    };

    const handleMouseUp = () => {
      setIsScrubbing(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isScrubbing, handleSeekFromEvent]);

  return (
    <div className="w-full max-w-6xl mx-auto flex flex-col bg-surface-container-low/90 rounded-2xl border border-outline-variant/30 shadow-2xl overflow-hidden backdrop-blur-xl">
      {/* 1. Multi-Track Sequencer Header & Ruler */}
      <div className="flex items-stretch border-b border-outline-variant/30 bg-surface-container-highest/50 select-none">
        {/* Left Column Header */}
        <div className="w-56 shrink-0 px-md py-xs flex items-center justify-between border-r border-outline-variant/30 bg-surface-container/60">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[16px] text-primary">view_timeline</span>
            <span className="font-label-caps text-[11px] font-semibold tracking-wider text-primary">
              SCENE ACTORS ({characters.length})
            </span>
          </div>
          {onAddActor && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onAddActor('soma')}
                title="Add SOMA Actor to Scene"
                className="px-1.5 py-[2px] bg-primary/15 hover:bg-primary/25 border border-primary/40 rounded text-[9px] font-label-caps text-primary cursor-pointer transition-colors"
              >
                +SOMA
              </button>
              <button
                onClick={() => onAddActor('g1')}
                title="Add G1 Humanoid Actor to Scene"
                className="px-1.5 py-[2px] bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 rounded text-[9px] font-label-caps text-amber-300 cursor-pointer transition-colors"
              >
                +G1
              </button>
            </div>
          )}
        </div>

        {/* Right Column: Time Ruler Bar */}
        <div
          ref={rulerRef}
          onMouseDown={handleMouseDown}
          className="flex-1 relative h-7 cursor-pointer overflow-hidden flex items-center"
        >
          {/* Second Tick Marks & Labels */}
          {tickMarks.map((sec) => {
            const leftPct = (sec / maxDuration) * 100;
            if (leftPct > 100) return null;
            return (
              <div
                key={sec}
                className="absolute top-0 bottom-0 flex flex-col justify-between pointer-events-none"
                style={{ left: `${leftPct}%` }}
              >
                <div className="w-[1px] h-2 bg-outline-variant/60" />
                <span className="font-mono text-[9px] text-on-surface-variant/80 -translate-x-1/2 select-none">
                  00:0{sec}
                </span>
                <div className="w-[1px] h-1.5 bg-outline-variant/40" />
              </div>
            );
          })}

          {/* Scrub Needle Top Cap on Ruler */}
          <div
            className="absolute top-0 bottom-0 z-30 pointer-events-none"
            style={{ left: `${playheadPercent}%` }}
          >
            <div className="w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[7px] border-t-primary -translate-x-1/2 filter drop-shadow(0 0 3px rgba(0,255,204,0.8))" />
          </div>
        </div>
      </div>

      {/* 2. Actors Track Lanes List */}
      <div className="flex flex-col divide-y divide-outline-variant/15 max-h-48 overflow-y-auto relative">
        {characters.map((actor) => {
          const isSelected = actor.id === selectedActorId;
          const actorDuration = actor.duration || 4.0;
          const clipWidthPct = Math.min(100, Math.max(5, (actorDuration / maxDuration) * 100));
          const hasKimodoMotion = !!actor.motionData;
          const constraints = actor.constraints || [];

          return (
            <div
              key={actor.id}
              onClick={() => onSelectActor(actor.id)}
              className={`flex items-stretch transition-colors cursor-pointer group ${
                isSelected
                  ? 'bg-primary/5 hover:bg-primary/10'
                  : 'bg-surface-container-lowest/40 hover:bg-surface-container-high/30'
              }`}
            >
              {/* Left Column: Actor Info Card */}
              <div
                className={`w-56 shrink-0 p-xs px-sm flex items-center justify-between border-r transition-all ${
                  isSelected
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-outline-variant/20 group-hover:border-outline-variant/40'
                }`}
              >
                <div className="flex items-center gap-xs overflow-hidden flex-1 mr-1">
                  {/* Avatar Picker Button */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveAvatarPickerActorId(activeAvatarPickerActorId === actor.id ? null : actor.id);
                        setActiveColorPickerActorId(null);
                      }}
                      title="Change Avatar Icon"
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-sm font-semibold shrink-0 shadow-sm border border-outline-variant/30 hover:scale-105 transition-transform cursor-pointer"
                      style={{
                        backgroundColor: isSelected ? `${actor.color || '#00ffcc'}25` : '#1e242a',
                        borderColor: actor.color || '#00ffcc',
                      }}
                    >
                      <span>{actor.avatar || '🏃'}</span>
                    </button>

                    {/* Avatar Selector Popover */}
                    {activeAvatarPickerActorId === actor.id && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-8 left-0 z-50 bg-surface-container-high border border-outline-variant/40 p-xs rounded-xl shadow-2xl flex flex-col gap-1 w-36 backdrop-blur-xl animate-fadeIn"
                      >
                        <div className="flex items-center justify-between text-[10px] font-label-caps text-on-surface-variant">
                          <span>AVATAR</span>
                          <button
                            onClick={() => setActiveAvatarPickerActorId(null)}
                            className="text-on-surface-variant hover:text-primary cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>
                        <div className="grid grid-cols-4 gap-1">
                          {PRESET_AVATARS.map((av) => (
                            <button
                              key={av}
                              type="button"
                              onClick={() => {
                                if (onUpdateActorProps) onUpdateActorProps(actor.id, { avatar: av });
                                setActiveAvatarPickerActorId(null);
                              }}
                              className="w-7 h-7 rounded-md bg-surface-container hover:bg-surface-variant flex items-center justify-center text-base hover:scale-110 cursor-pointer transition-transform"
                            >
                              {av}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Name and Color Details */}
                  <div className="flex flex-col overflow-hidden flex-1">
                    {editingActorId === actor.id ? (
                      <input
                        type="text"
                        autoFocus
                        value={editingName}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => {
                          if (editingName.trim() && onUpdateActorProps) {
                            onUpdateActorProps(actor.id, { name: editingName.trim() });
                          }
                          setEditingActorId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (editingName.trim() && onUpdateActorProps) {
                              onUpdateActorProps(actor.id, { name: editingName.trim() });
                            }
                            setEditingActorId(null);
                          } else if (e.key === 'Escape') {
                            setEditingActorId(null);
                          }
                        }}
                        className="bg-surface-container border border-primary text-xs font-semibold px-1 py-0 rounded text-primary focus:outline-none w-full"
                      />
                    ) : (
                      <div className="flex items-center gap-1 group/name">
                        <span
                          className={`text-xs font-semibold truncate max-w-[100px] ${
                            isSelected ? 'text-primary' : 'text-on-surface'
                          }`}
                          title={`${actor.name} (Click edit to rename)`}
                        >
                          {actor.name}
                        </span>
                        {onUpdateActorProps && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingActorId(actor.id);
                              setEditingName(actor.name);
                            }}
                            title="Rename Actor"
                            className="opacity-0 group-hover/name:opacity-100 hover:text-primary text-on-surface-variant p-0.5 rounded cursor-pointer transition-opacity"
                          >
                            <span className="material-symbols-outlined text-[12px]">edit</span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Mesh Color Swatch and Character Type */}
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-on-surface-variant">
                      <div className="relative">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveColorPickerActorId(activeColorPickerActorId === actor.id ? null : actor.id);
                            setActiveAvatarPickerActorId(null);
                          }}
                          title="Change Mesh Material Color"
                          className="w-3 h-3 rounded-full border border-white/40 shadow-sm cursor-pointer hover:scale-125 transition-transform flex items-center justify-center mt-[1px]"
                          style={{ backgroundColor: actor.color || '#00ffcc' }}
                        />

                        {/* Mesh Color Palette Popover */}
                        {activeColorPickerActorId === actor.id && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute top-5 left-0 z-50 bg-surface-container-high border border-outline-variant/40 p-xs rounded-xl shadow-2xl flex flex-col gap-1 w-44 backdrop-blur-xl animate-fadeIn"
                          >
                            <div className="flex items-center justify-between text-[10px] font-label-caps text-on-surface-variant">
                              <span>MESH COLOR</span>
                              <button
                                onClick={() => setActiveColorPickerActorId(null)}
                                className="text-on-surface-variant hover:text-primary cursor-pointer"
                              >
                                ✕
                              </button>
                            </div>
                            <div className="grid grid-cols-5 gap-1">
                              {PRESET_ACTOR_COLORS.map((hex) => (
                                <button
                                  key={hex}
                                  type="button"
                                  onClick={() => {
                                    if (onUpdateActorProps) onUpdateActorProps(actor.id, { color: hex });
                                    setActiveColorPickerActorId(null);
                                  }}
                                  className={`w-6 h-6 rounded-md border transition-transform hover:scale-110 cursor-pointer ${
                                    actor.color === hex ? 'border-white ring-1 ring-primary' : 'border-black/30'
                                  }`}
                                  style={{ backgroundColor: hex }}
                                />
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-1 pt-1 border-t border-outline-variant/20 text-[10px]">
                              <span className="text-on-surface-variant">Custom:</span>
                              <input
                                type="color"
                                value={actor.color || '#00ffcc'}
                                onChange={(e) => {
                                  if (onUpdateActorProps) onUpdateActorProps(actor.id, { color: e.target.value });
                                }}
                                className="w-6 h-5 bg-transparent border-0 rounded cursor-pointer"
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <span className="truncate text-[9px]">
                        {actor.characterType === 'g1' ? 'Unit G1' : 'SOMA 77B'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Status Indicator */}
                <div className="flex flex-col items-end shrink-0 pl-1">
                  {hasKimodoMotion ? (
                    <span className="text-[8px] font-mono bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1 rounded-sm flex items-center gap-0.5">
                      <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                      AI
                    </span>
                  ) : (
                    <span className="text-[8px] font-mono text-on-surface-variant/50">IDLE</span>
                  )}
                  <span className="font-mono text-[9px] text-on-surface-variant/80">
                    {actorDuration.toFixed(1)}s
                  </span>
                </div>
              </div>

              {/* Right Column: Track Lane & Motion Duration Block */}
              <div
                onMouseDown={handleMouseDown}
                className="flex-1 relative h-12 flex items-center px-0 overflow-hidden select-none bg-surface-container-lowest/30"
              >
                {/* Background Vertical Seconds Grid Lines */}
                {tickMarks.map((sec) => {
                  const leftPct = (sec / maxDuration) * 100;
                  if (leftPct > 100) return null;
                  return (
                    <div
                      key={sec}
                      className="absolute top-0 bottom-0 w-[1px] bg-outline-variant/10 pointer-events-none"
                      style={{ left: `${leftPct}%` }}
                    />
                  );
                })}

                {/* Motion Duration Clip Block */}
                <div
                  className={`absolute top-1.5 bottom-1.5 rounded-lg border shadow-md flex flex-col justify-center px-sm overflow-hidden transition-all ${
                    hasKimodoMotion
                      ? 'bg-gradient-to-r from-emerald-950/50 via-surface-container to-cyan-950/40 border-emerald-500/40 text-emerald-200'
                      : isSelected
                      ? 'bg-gradient-to-r from-primary/20 via-surface-container to-primary/10 border-primary/50 text-primary'
                      : 'bg-surface-container border-outline-variant/40 text-on-surface-variant'
                  }`}
                  style={{
                    left: 0,
                    width: `${clipWidthPct}%`,
                  }}
                >
                  {/* Clip Header Line: Motion Prompt & Duration */}
                  <div className="flex items-center justify-between gap-1 overflow-hidden">
                    <span className="text-[11px] font-medium truncate flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px] shrink-0">
                        {hasKimodoMotion ? 'auto_awesome' : 'directions_walk'}
                      </span>
                      <span className="truncate">
                        {actor.motionPrompt || actor.currentAnimation || 'Default Stance'}
                      </span>
                    </span>
                    <span className="font-mono text-[10px] bg-black/40 px-1 rounded shrink-0 border border-white/10">
                      {actorDuration.toFixed(1)}s {actor.motionData ? `(${actor.motionData.num_frames}f)` : ''}
                    </span>
                  </div>

                  {/* Sub-Track: Active Constraints Visualizer Pills */}
                  {constraints.length > 0 && (
                    <div className="flex items-center gap-1 mt-0.5 overflow-hidden">
                      {constraints
                        .filter((c) => c.enabled)
                        .map((c) => {
                          const meta = CONSTRAINT_COLOR_MAP[c.type] || {
                            bg: 'bg-primary/20',
                            border: 'border-primary/40',
                            text: 'text-primary',
                            icon: 'tune',
                          };
                          const isCurrentlyFiring =
                            timelineSec >= c.startTime && timelineSec <= c.endTime;

                          return (
                            <span
                              key={c.id}
                              className={`text-[8px] font-mono px-1 py-[1px] rounded border flex items-center gap-0.5 truncate max-w-[120px] ${
                                meta.bg
                              } ${meta.border} ${meta.text} ${
                                isCurrentlyFiring ? 'ring-1 ring-white/50 brightness-125' : 'opacity-80'
                              }`}
                              title={`${c.name} (${c.startTime}s - ${c.endTime}s)`}
                            >
                              <span className="material-symbols-outlined text-[10px]">{meta.icon}</span>
                              <span className="truncate">{c.name}</span>
                            </span>
                          );
                        })}
                    </div>
                  )}
                </div>

                {/* Interactive Playhead Needle Across Track */}
                <div
                  className="absolute top-0 bottom-0 w-[2px] bg-primary z-20 pointer-events-none shadow-[0_0_8px_rgba(0,255,204,0.9)]"
                  style={{ left: `${playheadPercent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* 3. Transport Controls & Master Timeline Scrubber */}
      <div className="flex items-center justify-between gap-md px-md py-xs bg-surface-container border-t border-outline-variant/20">
        {/* Playback Controls */}
        <div className="flex items-center gap-xs">
          {/* Play / Pause */}
          <button
            onClick={onTogglePlay}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            className="p-xs text-primary hover:bg-surface-variant rounded-lg transition-colors cursor-pointer flex items-center justify-center"
          >
            <span className="material-symbols-outlined text-[24px]">
              {isPlaying ? 'pause' : 'play_arrow'}
            </span>
          </button>

          {/* Replay to 0 */}
          <button
            onClick={onResetTime}
            title="Reset to 00:00"
            className="p-xs text-on-surface-variant hover:text-primary rounded-lg transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">replay</span>
          </button>

          {/* Time Counter */}
          <span className="font-mono text-xs text-primary tracking-wider ml-xs font-semibold">
            00:{timelineSec.toFixed(1).padStart(4, '0')} / 00:{maxDuration.toFixed(1).padStart(4, '0')}
          </span>

          {/* Playback Speed Select */}
          <div className="flex items-center gap-[2px] ml-sm bg-surface-container-low border border-outline-variant/30 rounded p-[2px]">
            {[0.5, 1.0, 1.5, 2.0].map((spd) => (
              <button
                key={spd}
                onClick={() => onChangePlaybackSpeed(spd)}
                className={`px-xs py-[1px] text-[10px] font-label-caps rounded cursor-pointer ${
                  playbackSpeed === spd
                    ? 'bg-primary text-background font-semibold'
                    : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>

        {/* Master Timeline Slider */}
        <div className="flex-1 mx-md relative flex items-center">
          <input
            type="range"
            min="0"
            max={maxDuration}
            step="0.05"
            value={timelineSec}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="w-full accent-primary h-1.5 bg-surface-container-highest rounded-lg cursor-pointer"
          />
        </div>

        {/* Advance to Stage 03: Record */}
        <div className="flex items-center gap-sm">
          <span className="font-label-caps text-[10px] text-on-surface-variant tracking-widest uppercase">
            MULTI-ACTOR STAGE
          </span>
          {onNavigateStage && (
            <button
              onClick={() => onNavigateStage('stage3_camera')}
              className="bg-surface-container-highest hover:bg-surface-variant border border-outline-variant/40 text-primary font-label-caps text-xs px-md py-xs rounded-lg flex items-center gap-xs transition-colors cursor-pointer"
            >
              <span>RECORD (STAGE 03)</span>
              <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
