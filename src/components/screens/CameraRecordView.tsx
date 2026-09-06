import React, { useState, useEffect, useRef } from 'react';
import { Project, CharacterActor } from '../../types';
import { ThreeStage } from '../viewport/ThreeStage';
import { DEFAULT_INITIAL_ACTORS } from './ActingSetupView';

interface CameraRecordViewProps {
  currentProject: Project;
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

export const CameraRecordView: React.FC<CameraRecordViewProps> = ({ currentProject }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [showQRPairing, setShowQRPairing] = useState(false);
  const [focalLength, setFocalLength] = useState('35mm');
  const [iso, setIso] = useState('800');

  // Synchronize actors from project or default initial actors
  const characters: CharacterActor[] = (currentProject.characters && currentProject.characters.length > 0)
    ? currentProject.characters
    : DEFAULT_INITIAL_ACTORS;

  const assets = currentProject.scenes || [];
  const maxDuration = Math.max(5.0, ...characters.map((c) => c.duration || (c.motionData?.duration) || 4.0));

  // Master Timeline Animation State
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [timelineSec, setTimelineSec] = useState<number>(0);
  const [playbackSpeed] = useState<number>(1.0);

  // 60 FPS Master Timeline Animation Loop
  const lastTimeRef = useRef<number>(performance.now());
  useEffect(() => {
    let animFrame: number;
    const updateTimeline = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      if (isPlaying) {
        setTimelineSec((prev) => {
          const next = prev + dt * playbackSpeed;
          return next >= maxDuration ? 0 : next;
        });
      }
      animFrame = requestAnimationFrame(updateTimeline);
    };
    animFrame = requestAnimationFrame(updateTimeline);
    return () => cancelAnimationFrame(animFrame);
  }, [isPlaying, playbackSpeed, maxDuration]);

  // Recording Timer
  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => {
        setRecSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  const handleToggleRecord = () => {
    if (!isRecording) {
      setIsRecording(true);
      setRecSeconds(0);
      setIsPlaying(true); // Auto-play timeline on record action
    } else {
      setIsRecording(false);
    }
  };

  const handleRewind = () => {
    setTimelineSec(0);
  };

  const currentFov = LENS_FOV_MAP[focalLength] || 54;

  return (
    <div className="relative w-full h-[calc(100vh-61px)] overflow-hidden bg-background">
      {/* 3D Scene Viewport with Stage Assets & Animated Character Actors */}
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
      />

      {/* Cinematic Viewfinder HUD Overlay */}
      <div className="absolute inset-0 pointer-events-none p-lg flex flex-col justify-between z-20">
        {/* Top HUD Bar */}
        <div className="flex justify-between items-start">
          {/* Left: Recording Status & Active Cast on Set */}
          <div className="flex flex-col gap-2 pointer-events-auto">
            <div className="flex items-center gap-md">
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

          {/* Right: Camera Optical Specs */}
          <div className="flex items-center gap-sm font-label-caps text-xs text-on-surface-variant bg-background/85 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30 shadow-md">
            <span className="text-primary font-medium">LENS: {focalLength} ({currentFov}°)</span>
            <span className="text-outline-variant">|</span>
            <span>ISO: {iso}</span>
            <span className="text-outline-variant">|</span>
            <span className="text-emerald-400 font-medium font-mono">60 FPS</span>
          </div>
        </div>

        {/* Center Crosshair Grid Overlay with Framing Guides */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-56 border border-primary/20 pointer-events-none flex items-center justify-center">
          <div className="w-5 h-5 border-t-2 border-l-2 border-primary/50 absolute top-0 left-0" />
          <div className="w-5 h-5 border-t-2 border-r-2 border-primary/50 absolute top-0 right-0" />
          <div className="w-5 h-5 border-b-2 border-l-2 border-primary/50 absolute bottom-0 left-0" />
          <div className="w-5 h-5 border-b-2 border-r-2 border-primary/50 absolute bottom-0 right-0" />
          <div className="w-2.5 h-2.5 bg-primary/50 rounded-full" />
        </div>

        {/* Bottom Floating Control Bar */}
        <div className="flex flex-col gap-3 pointer-events-auto">
          {/* Action Playback & Timeline Scrubber Bar */}
          <div className="w-full max-w-2xl mx-auto bg-surface-container/95 border border-outline-variant/40 rounded-xl p-2.5 backdrop-blur-xl shadow-2xl flex items-center gap-3">
            {/* Play/Pause Button */}
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="p-1.5 rounded-lg bg-surface-container-high hover:bg-primary hover:text-background text-primary border border-outline-variant/50 transition-colors flex items-center justify-center cursor-pointer"
              title={isPlaying ? 'Pause Motion Playback' : 'Play Motion Playback'}
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
                max={maxDuration}
                step="0.033"
                value={timelineSec}
                onChange={(e) => {
                  setTimelineSec(parseFloat(e.target.value));
                }}
                className="w-full h-1.5 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* Timecode Indicator */}
            <div className="font-mono text-xs text-primary font-semibold tracking-wider whitespace-nowrap bg-surface-container-highest/80 px-2 py-1 rounded border border-outline-variant/30">
              {formatTime(timelineSec)} / {formatTime(maxDuration)}
            </div>
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

            {/* Main Record Action Button */}
            <div className="flex items-center gap-md">
              <button
                onClick={handleToggleRecord}
                className={`w-14 h-14 rounded-full flex items-center justify-center cursor-pointer shadow-2xl transition-transform hover:scale-105 ${
                  isRecording
                    ? 'bg-red-600 ring-4 ring-red-400/40 text-white'
                    : 'bg-primary text-background'
                }`}
                title={isRecording ? 'Stop Recording' : 'Start Recording Take'}
              >
                <span className="material-symbols-outlined text-[28px]">
                  {isRecording ? 'stop' : 'videocam'}
                </span>
              </button>
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
