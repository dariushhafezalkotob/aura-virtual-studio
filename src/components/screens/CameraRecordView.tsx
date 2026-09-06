import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Project, CharacterActor, CameraTake, CameraKeyframe } from '../../types';
import { ThreeStage } from '../viewport/ThreeStage';
import { DEFAULT_INITIAL_ACTORS } from './ActingSetupView';

interface CameraRecordViewProps {
  currentProject: Project;
  onUpdateProject?: (updated: Project) => void;
}

const LENS_FOV_MAP: Record<string, number> = {
  '24mm': 74,
  '35mm': 54,
  '50mm': 40,
  '85mm': 24,
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
}

export const CameraRecordView: React.FC<CameraRecordViewProps> = ({ currentProject, onUpdateProject }) => {
  // Mode: Live Camera Flight vs Playback Take Review
  const [viewMode, setViewMode] = useState<'live' | 'playback'>('live');
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [showQRPairing, setShowQRPairing] = useState(false);
  const [focalLength, setFocalLength] = useState('35mm');
  const [iso, setIso] = useState('800');

  // Takes Management
  const [takes, setTakes] = useState<CameraTake[]>(currentProject.cameraTakes || []);
  const [activeTakeId, setActiveTakeId] = useState<string | null>(
    currentProject.cameraTakes && currentProject.cameraTakes.length > 0
      ? currentProject.cameraTakes[currentProject.cameraTakes.length - 1].id
      : null
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Synchronize actors from project or default initial actors
  const characters: CharacterActor[] = (currentProject.characters && currentProject.characters.length > 0)
    ? currentProject.characters
    : DEFAULT_INITIAL_ACTORS;

  const assets = currentProject.scenes || [];
  const maxDuration = Math.max(5.0, ...characters.map((c) => c.duration || (c.motionData?.duration) || 4.0));

  // Active Take Reference
  const activeTake = takes.find((t) => t.id === activeTakeId) || (takes.length > 0 ? takes[takes.length - 1] : null);
  const effectiveDuration = (viewMode === 'playback' && activeTake) ? activeTake.duration : maxDuration;

  // Master Timeline Animation State
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [timelineSec, setTimelineSec] = useState<number>(0);
  const [playbackSpeed] = useState<number>(1.0);

  // Keyframes buffer collected while recording
  const recordedFramesRef = useRef<CameraKeyframe[]>([]);

  // Frame Recording Callback from ThreeStage
  const handleRecordFrame = useCallback((frame: CameraKeyframe) => {
    recordedFramesRef.current.push(frame);
  }, []);

  // Stop Recording Handler
  const stopRecording = useCallback(() => {
    setIsRecording(false);
    setIsPlaying(false);

    const frames = [...recordedFramesRef.current];
    if (frames.length > 5) {
      const recordedDuration = Number(Math.max(0.5, timelineSec).toFixed(2));
      const takeNumber = takes.length + 1;
      const newTake: CameraTake = {
        id: `take_${Date.now()}`,
        name: `Take ${takeNumber}`,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        duration: recordedDuration,
        keyframes: frames,
        focalLength,
        fps: 60,
      };

      const updatedTakes = [...takes, newTake];
      setTakes(updatedTakes);
      setActiveTakeId(newTake.id);
      setViewMode('playback'); // Seamlessly transition to review take mode!
      setTimelineSec(0);

      if (onUpdateProject) {
        onUpdateProject({
          ...currentProject,
          cameraTakes: updatedTakes,
        });
      }

      setToastMessage(`Take ${takeNumber} recorded! (${recordedDuration}s • ${frames.length} frames) — Press Play to Review!`);
      setTimeout(() => setToastMessage(null), 4500);
    } else {
      setToastMessage('Take too short — recorded frames discarded.');
      setTimeout(() => setToastMessage(null), 3000);
    }
  }, [takes, timelineSec, focalLength, currentProject, onUpdateProject]);

  // 60 FPS Master Timeline Animation Loop
  const lastTimeRef = useRef<number>(performance.now());
  useEffect(() => {
    let animFrame: number;
    const updateTimeline = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      const dur = (viewMode === 'playback' && activeTake) ? activeTake.duration : maxDuration;

      if (isPlaying) {
        setTimelineSec((prev) => {
          const next = prev + dt * playbackSpeed;
          if (next >= dur) {
            if (isRecording) {
              // Automatically wrap up recording when timeline finishes sequence
              stopRecording();
              return dur;
            } else if (viewMode === 'playback') {
              // Pause cleanly at end of take review
              setIsPlaying(false);
              return dur;
            } else {
              // Loop live standby playback
              return 0;
            }
          }
          return next;
        });
      }
      animFrame = requestAnimationFrame(updateTimeline);
    };
    animFrame = requestAnimationFrame(updateTimeline);
    return () => cancelAnimationFrame(animFrame);
  }, [isPlaying, playbackSpeed, maxDuration, viewMode, activeTake, isRecording, stopRecording]);

  // Recording Duration Counter
  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => {
        setRecSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  // Toggle Record Button Handler
  const handleToggleRecord = () => {
    if (!isRecording) {
      // Start recording
      recordedFramesRef.current = [];
      setTimelineSec(0);
      setViewMode('live');
      setIsRecording(true);
      setRecSeconds(0);
      setIsPlaying(true); // Actors start animating from t=0
    } else {
      // Stop recording
      stopRecording();
    }
  };

  const handleRewind = () => {
    setTimelineSec(0);
  };

  const handleDeleteTake = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (window.confirm('Delete this recorded camera take?')) {
      const updated = takes.filter((t) => t.id !== id);
      setTakes(updated);
      if (activeTakeId === id) {
        if (updated.length > 0) {
          setActiveTakeId(updated[updated.length - 1].id);
        } else {
          setActiveTakeId(null);
          setViewMode('live');
        }
      }
      if (onUpdateProject) {
        onUpdateProject({
          ...currentProject,
          cameraTakes: updated,
        });
      }
    }
  };

  const handleExportTakeJson = (take: CameraTake, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(take, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `${take.name.toLowerCase().replace(/\s+/g, '_')}_camera.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const currentFov = LENS_FOV_MAP[focalLength] || 54;

  return (
    <div className="relative w-full h-[calc(100vh-61px)] overflow-hidden bg-background select-none">
      {/* 3D Scene Viewport with Stage Assets, Character Actors, and Camera Recording/Playback */}
      <ThreeStage
        assets={assets}
        selectedAssetId={null}
        characters={characters}
        currentTimelineTime={timelineSec}
        isPlaying={isPlaying}
        showTrajectories={false}
        panoramaUrl={currentProject.panoramaUrl}
        panoramaRotation={currentProject.panoramaRotation || 0}
        splatUrl={currentProject.splatUrl}
        cameraFov={currentFov}
        isRecordingCamera={isRecording}
        onRecordCameraFrame={handleRecordFrame}
        isPlaybackTake={viewMode === 'playback'}
        playbackTake={activeTake}
        showCameraTrajectory={true}
      />

      {/* Toast Alert Banner */}
      {toastMessage && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 bg-surface-container-highest/95 border border-primary/50 text-primary px-4 py-2 rounded-xl backdrop-blur-xl shadow-2xl font-mono text-xs flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
          <span className="material-symbols-outlined text-primary text-[18px]">check_circle</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Cinematic Viewfinder HUD Overlay */}
      <div className="absolute inset-0 pointer-events-none p-lg flex flex-col justify-between z-20">
        {/* Top HUD Bar */}
        <div className="flex justify-between items-start">
          {/* Left: Mode Switcher, Recording Status & Active Cast */}
          <div className="flex flex-col gap-2 pointer-events-auto">
            {/* Primary Mode Switcher Pills */}
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-surface-container/90 backdrop-blur-md rounded-lg p-0.5 border border-outline-variant/40 shadow-md">
                <button
                  onClick={() => {
                    setViewMode('live');
                    setIsPlaying(true);
                  }}
                  className={`px-3 py-1 text-xs font-label-caps rounded-md cursor-pointer flex items-center gap-1.5 transition-all ${
                    viewMode === 'live'
                      ? 'bg-primary text-background font-semibold shadow-sm'
                      : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-emerald-400'}`} />
                  LIVE CAMERA
                </button>
                <button
                  onClick={() => {
                    if (takes.length > 0) {
                      setViewMode('playback');
                      setTimelineSec(0);
                      setIsPlaying(false);
                    }
                  }}
                  disabled={takes.length === 0}
                  className={`px-3 py-1 text-xs font-label-caps rounded-md cursor-pointer flex items-center gap-1.5 transition-all ${
                    takes.length === 0 ? 'opacity-40 cursor-not-allowed text-on-surface-variant' : ''
                  } ${
                    viewMode === 'playback'
                      ? 'bg-cyan-500 text-background font-semibold shadow-sm'
                      : 'text-on-surface-variant hover:text-cyan-400'
                  }`}
                >
                  <span className="material-symbols-outlined text-[15px]">movie</span>
                  REVIEW TAKES {takes.length > 0 ? `(${takes.length})` : ''}
                </button>
              </div>

              {/* Status Badge */}
              {viewMode === 'live' ? (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-xs bg-background/85 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30 font-label-caps text-xs shadow-md">
                    <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-green-500'}`} />
                    <span className="text-primary tracking-widest font-semibold">{isRecording ? 'RECORDING TAKE' : 'STANDBY'}</span>
                  </div>
                  {isRecording && (
                    <span className="font-mono text-xs text-red-400 font-bold tracking-widest bg-background/85 backdrop-blur-md px-sm py-xs border border-red-500/50 rounded shadow-md">
                      REC 00:{recSeconds.toString().padStart(2, '0')}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 bg-cyan-950/80 border border-cyan-500/40 backdrop-blur-md px-3 py-1 rounded text-cyan-300 text-xs font-mono shadow-md">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                    <span>PLAYBACK MONITOR: {activeTake?.name}</span>
                    <span className="text-[10px] text-cyan-400/80">({activeTake?.duration}s)</span>
                  </div>
                </div>
              )}
            </div>

            {/* Takes Selector Pills Bar (Visible in Playback Mode) */}
            {viewMode === 'playback' && takes.length > 0 && (
              <div className="flex items-center gap-1.5 bg-background/85 backdrop-blur-md p-1 rounded-lg border border-outline-variant/30 shadow-md overflow-x-auto max-w-xl">
                <span className="font-mono text-[10px] text-on-surface-variant font-medium tracking-wider uppercase px-1">
                  TAKES:
                </span>
                {takes.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => {
                      setActiveTakeId(t.id);
                      setTimelineSec(0);
                      setIsPlaying(false);
                    }}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono cursor-pointer transition-all border ${
                      activeTake?.id === t.id
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500 font-semibold'
                        : 'bg-surface-container/60 text-on-surface-variant border-transparent hover:border-outline-variant/60'
                    }`}
                  >
                    <span>{t.name}</span>
                    <span className="text-[10px] opacity-70">({t.duration}s)</span>
                    {activeTake?.id === t.id && (
                      <div className="flex items-center gap-1 ml-1">
                        <button
                          onClick={(e) => handleExportTakeJson(t, e)}
                          title="Export Take JSON"
                          className="hover:text-white"
                        >
                          <span className="material-symbols-outlined text-[13px]">download</span>
                        </button>
                        <button
                          onClick={(e) => handleDeleteTake(t.id, e)}
                          title="Delete Take"
                          className="hover:text-red-400"
                        >
                          <span className="material-symbols-outlined text-[13px]">delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Cast On Set Badges */}
            <div className="flex items-center gap-1.5 bg-background/80 backdrop-blur-md px-2.5 py-1 rounded-lg border border-outline-variant/30 text-xs shadow-sm">
              <span className="font-mono text-[10px] text-on-surface-variant font-medium tracking-wider uppercase mr-1">
                CAST ({characters.length}):
              </span>
              {characters.map((actor) => (
                <div
                  key={actor.id}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-container-high/90 border border-outline-variant/40"
                  style={{ borderColor: `${actor.color}40` }}
                >
                  <span className="text-xs">{actor.avatar || '👤'}</span>
                  <span className="font-mono text-[11px] font-semibold text-on-surface" style={{ color: actor.color }}>
                    {actor.name}
                  </span>
                  {actor.motionData ? (
                    <span className="text-[9px] font-mono text-cyan-400 bg-cyan-950/60 px-1 py-0.2 rounded border border-cyan-500/30">
                      DIFFUSION (30FPS)
                    </span>
                  ) : (
                    <span className="text-[9px] font-mono text-on-surface-variant/80">
                      {actor.currentAnimation || 'Idle'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Right: Camera Optical Specs & Take Count */}
          <div className="flex flex-col gap-2 items-end pointer-events-auto">
            <div className="flex items-center gap-sm font-label-caps text-xs text-on-surface-variant bg-background/85 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30 shadow-md">
              <span className="text-primary font-medium">LENS: {focalLength} ({currentFov}°)</span>
              <span className="text-outline-variant">|</span>
              <span>ISO: {iso}</span>
              <span className="text-outline-variant">|</span>
              <span className="text-emerald-400 font-medium font-mono">60 FPS</span>
            </div>
            {takes.length > 0 && (
              <div className="font-mono text-[10px] text-cyan-400/90 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-500/30">
                {takes.length} {takes.length === 1 ? 'TAKE' : 'TAKES'} RECORDED
              </div>
            )}
          </div>
        </div>

        {/* Center Prompt / Crosshairs */}
        {viewMode === 'playback' && !isPlaying && activeTake && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-3 pointer-events-auto z-30">
            <button
              onClick={() => {
                if (timelineSec >= activeTake.duration) {
                  setTimelineSec(0);
                }
                setIsPlaying(true);
              }}
              className="px-6 py-3.5 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-background font-label-caps text-sm tracking-widest font-bold shadow-2xl flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer border border-cyan-300"
            >
              <span className="material-symbols-outlined text-[24px]">play_arrow</span>
              PLAY RECORDED {activeTake.name.toUpperCase()}
            </button>
            <div className="flex items-center gap-2 bg-background/85 px-3 py-1 rounded-full border border-outline-variant/40 backdrop-blur-md text-[11px] font-mono text-cyan-300">
              <span>{activeTake.keyframes.length} Frames</span>
              <span>•</span>
              <span>{activeTake.duration}s Sequence</span>
              <span>•</span>
              <span>Synced Actors & Camera</span>
            </div>
          </div>
        )}

        {/* Center Crosshair Grid Overlay with Framing Guides */}
        {viewMode === 'live' && (
          <div
            className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-56 border pointer-events-none flex items-center justify-center transition-colors ${
              isRecording ? 'border-red-500/40' : 'border-primary/20'
            }`}
          >
            <div className={`w-5 h-5 border-t-2 border-l-2 absolute top-0 left-0 ${isRecording ? 'border-red-500' : 'border-primary/50'}`} />
            <div className={`w-5 h-5 border-t-2 border-r-2 absolute top-0 right-0 ${isRecording ? 'border-red-500' : 'border-primary/50'}`} />
            <div className={`w-5 h-5 border-b-2 border-l-2 absolute bottom-0 left-0 ${isRecording ? 'border-red-500' : 'border-primary/50'}`} />
            <div className={`w-5 h-5 border-b-2 border-r-2 absolute bottom-0 right-0 ${isRecording ? 'border-red-500' : 'border-primary/50'}`} />
            <div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-primary/50'}`} />
          </div>
        )}

        {/* Bottom Floating Control Bar */}
        <div className="flex flex-col gap-3 pointer-events-auto">
          {/* Action Playback & Timeline Scrubber Bar */}
          <div className="w-full max-w-2xl mx-auto bg-surface-container/95 border border-outline-variant/40 rounded-xl p-2.5 backdrop-blur-xl shadow-2xl flex items-center gap-3">
            {/* Play/Pause Button */}
            <button
              onClick={() => {
                if (!isPlaying && timelineSec >= effectiveDuration) {
                  setTimelineSec(0);
                }
                setIsPlaying(!isPlaying);
              }}
              className={`p-1.5 rounded-lg border transition-colors flex items-center justify-center cursor-pointer ${
                viewMode === 'playback'
                  ? 'bg-cyan-500/20 hover:bg-cyan-500 hover:text-background text-cyan-300 border-cyan-500/50'
                  : 'bg-surface-container-high hover:bg-primary hover:text-background text-primary border-outline-variant/50'
              }`}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              <span className="material-symbols-outlined text-[20px]">
                {isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>

            {/* Rewind Button */}
            <button
              onClick={handleRewind}
              className="p-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface border border-outline-variant/50 transition-colors flex items-center justify-center cursor-pointer"
              title="Rewind to Frame 0"
            >
              <span className="material-symbols-outlined text-[18px]">
                skip_previous
              </span>
            </button>

            {/* Timeline Progress Slider */}
            <div className="flex-1 flex flex-col gap-1">
              <input
                type="range"
                min="0"
                max={effectiveDuration}
                step="0.033"
                value={timelineSec}
                onChange={(e) => {
                  setTimelineSec(parseFloat(e.target.value));
                }}
                className={`w-full h-1.5 rounded-lg appearance-none cursor-pointer ${
                  viewMode === 'playback'
                    ? 'bg-cyan-950 accent-cyan-400'
                    : 'bg-surface-container-highest accent-primary'
                }`}
              />
            </div>

            {/* Timecode Indicator */}
            <div
              className={`font-mono text-xs font-semibold tracking-wider whitespace-nowrap px-2 py-1 rounded border ${
                viewMode === 'playback'
                  ? 'text-cyan-300 bg-cyan-950/60 border-cyan-500/40'
                  : 'text-primary bg-surface-container-highest/80 border-outline-variant/30'
              }`}
            >
              {formatTime(timelineSec)} / {formatTime(effectiveDuration)}
            </div>

            {/* Playback Mode Extra Action: Switch to Live / Record New */}
            {viewMode === 'playback' && (
              <button
                onClick={() => {
                  setViewMode('live');
                  setIsPlaying(true);
                }}
                className="px-2 py-1 text-[11px] font-label-caps rounded bg-surface-container-high hover:bg-surface-container-highest text-on-surface border border-outline-variant/50 flex items-center gap-1 cursor-pointer transition-colors"
                title="Return to Live Camera flight and record a new take"
              >
                <span className="material-symbols-outlined text-[14px]">videocam</span>
                LIVE CAM
              </button>
            )}
          </div>

          {/* Director Viewfinder Control Strip */}
          <div className="flex justify-between items-end">
            {/* Mobile Camera Pairing Button */}
            <button
              onClick={() => setShowQRPairing(true)}
              className="bg-surface-container/90 border border-outline-variant/40 hover:border-primary px-md py-sm rounded-lg backdrop-blur-md text-xs font-label-caps text-primary tracking-widest flex items-center gap-xs cursor-pointer shadow-lg"
            >
              <span className="material-symbols-outlined text-[18px]">qr_code_scanner</span>
              PAIR PHONE / TABLET
            </button>

            {/* Main Action Buttons (Record / Stop / Review) */}
            <div className="flex items-center gap-md">
              {viewMode === 'playback' ? (
                <div className="flex items-center gap-3">
                  {/* Replay Take Button */}
                  <button
                    onClick={() => {
                      setTimelineSec(0);
                      setIsPlaying(true);
                    }}
                    className="h-12 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-background font-label-caps text-xs font-bold tracking-wider flex items-center gap-2 cursor-pointer shadow-xl transition-all"
                  >
                    <span className="material-symbols-outlined text-[20px]">replay</span>
                    REPLAY TAKE
                  </button>

                  {/* Record New Take Button */}
                  <button
                    onClick={() => {
                      setViewMode('live');
                      handleToggleRecord();
                    }}
                    className="h-12 px-5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-label-caps text-xs font-bold tracking-wider flex items-center gap-2 cursor-pointer shadow-xl transition-all"
                    title="Start recording a new take immediately"
                  >
                    <span className="material-symbols-outlined text-[20px]">videocam</span>
                    RECORD NEW TAKE
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleToggleRecord}
                  className={`w-14 h-14 rounded-full flex items-center justify-center cursor-pointer shadow-2xl transition-transform hover:scale-105 ${
                    isRecording
                      ? 'bg-red-600 ring-4 ring-red-400/40 text-white'
                      : 'bg-primary text-background'
                  }`}
                  title={isRecording ? 'Stop Recording Take' : 'Start Recording Take'}
                >
                  <span className="material-symbols-outlined text-[28px]">
                    {isRecording ? 'stop' : 'videocam'}
                  </span>
                </button>
              )}
            </div>

            {/* Lens & ISO Preset Selectors */}
            <div className="flex flex-col gap-xs items-end">
              <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-xs rounded-lg backdrop-blur-md shadow-md">
                <span className="font-label-caps text-[9px] text-on-surface-variant px-xs">LENS</span>
                {['24mm', '35mm', '50mm', '85mm'].map((fl) => (
                  <button
                    key={fl}
                    onClick={() => setFocalLength(fl)}
                    className={`px-sm py-xs text-[11px] font-label-caps rounded cursor-pointer transition-colors ${
                      focalLength === fl ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                    }`}
                  >
                    {fl}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-xs rounded-lg backdrop-blur-md shadow-md">
                <span className="font-label-caps text-[9px] text-on-surface-variant px-xs">ISO</span>
                {['400', '800', '1600'].map((val) => (
                  <button
                    key={val}
                    onClick={() => setIso(val)}
                    className={`px-sm py-xs text-[11px] font-label-caps rounded cursor-pointer transition-colors ${
                      iso === val ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                    }`}
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* QR Pairing Modal for Module 3 */}
      {showQRPairing && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md flex items-center justify-center p-md">
          <div className="bg-surface-container border border-outline-variant/40 p-xl max-w-sm w-full rounded-xl shadow-2xl text-center relative">
            <button
              onClick={() => setShowQRPairing(false)}
              className="absolute top-md right-md text-on-surface-variant hover:text-primary cursor-pointer"
            >
              ✕
            </button>
            <span className="font-label-caps text-[11px] text-primary tracking-widest block mb-xs">
              MODULE 03: VIRTUAL CAMERA
            </span>
            <h3 className="font-headline-sm text-primary mb-md font-semibold">
              Connect Mobile Director
            </h3>
            <div className="w-48 h-48 mx-auto bg-white p-md rounded-lg flex flex-col items-center justify-center border border-outline-variant/40 mb-md">
              <span className="material-symbols-outlined text-background text-[110px]">
                qr_code_2
              </span>
            </div>
            <p className="text-xs text-on-surface-variant mb-md leading-relaxed">
              Scan with your iPhone, iPad or Android device to enable real-time gyroscope & motion camera tracking.
            </p>
            <button
              onClick={() => setShowQRPairing(false)}
              className="w-full font-label-caps text-xs bg-primary text-background py-sm rounded font-medium cursor-pointer"
            >
              DONE
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
