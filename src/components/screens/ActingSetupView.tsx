import React, { useState, useEffect, useRef } from 'react';
import { Project, CharacterActor, WorkflowStage } from '../../types';
import { ThreeStage, TransformMode } from '../viewport/ThreeStage';
import { KimodoService, MOTION_PRESETS, MotionPreset } from '../../services/kimodoService';

interface ActingSetupViewProps {
  currentProject: Project;
  onUpdateProject: (updated: Project) => void;
  onNavigateStage?: (stage: WorkflowStage) => void;
}

const DEFAULT_INITIAL_ACTORS: CharacterActor[] = [
  {
    id: 'actor_soma_alpha',
    name: 'SOMA Lead (Alpha)',
    characterType: 'soma',
    avatar: '🏃',
    color: '#00ffcc',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    currentAnimation: 'Walk Forward',
    motionPrompt: 'walks forward steadily with natural arm sway',
    duration: 4.0,
    trajectory: KimodoService.generateTrajectory('straight', 4.0, [0, 0, 0], 1.0),
  },
  {
    id: 'actor_g1_unit',
    name: 'Unit G1 Humanoid',
    characterType: 'g1',
    avatar: '🤖',
    color: '#ff9500',
    position: [2.0, 0, -1.0],
    rotation: [0, -0.4, 0],
    scale: [1, 1, 1],
    currentAnimation: 'Wave & Greet',
    motionPrompt: 'stands, raises right hand high and waves warmly to the camera',
    duration: 3.0,
    trajectory: KimodoService.generateTrajectory('inplace', 3.0, [2.0, 0, -1.0], 1.0),
  },
];

const SUGGESTED_PROMPTS = [
  'walks forward 4 steps, stops and waves to camera',
  'jogs forward swiftly with dynamic athletic stride',
  'stands alert, scans the surroundings left and right',
  'executes a balanced martial arts kick and defensive pose',
  'dances with energetic hip sway and rhythmic arms',
  'talks expressively while gesturing with both hands',
  'walks along a curved circular perimeter inspecting stage',
];

export const ActingSetupView: React.FC<ActingSetupViewProps> = ({
  currentProject,
  onUpdateProject,
  onNavigateStage,
}) => {
  // Synchronize actors from project or default
  const characters: CharacterActor[] = (currentProject.characters && currentProject.characters.length > 0)
    ? currentProject.characters
    : DEFAULT_INITIAL_ACTORS;

  const [selectedActorId, setSelectedActorId] = useState<string>(characters[0]?.id || 'actor_soma_alpha');
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [motionPrompt, setMotionPrompt] = useState<string>('walks forward 4 steps, stops and waves to camera');
  const [durationSec, setDurationSec] = useState<number>(4.0);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1.0);
  const [trajectoryMode, setTrajectoryMode] = useState<'straight' | 'arc' | 'circle' | 'inplace'>('straight');
  const [showTrajectories, setShowTrajectories] = useState<boolean>(true);
  const [renderMode, setRenderMode] = useState<'mesh' | 'skeleton' | 'hybrid'>('mesh');
  const [showViserEmbed, setShowViserEmbed] = useState<boolean>(false);

  // Timeline playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [timelineSec, setTimelineSec] = useState<number>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string | null>(null);

  const selectedActor = characters.find((c) => c.id === selectedActorId) || characters[0];
  const maxDuration = Math.max(5.0, ...characters.map((c) => c.duration || 4.0));

  // Initialize actors on first mount if empty
  useEffect(() => {
    if (!currentProject.characters || currentProject.characters.length === 0) {
      onUpdateProject({
        ...currentProject,
        characters: DEFAULT_INITIAL_ACTORS,
      });
    }
  }, []);

  // Update prompt when selected actor changes
  useEffect(() => {
    if (selectedActor) {
      if (selectedActor.motionPrompt) setMotionPrompt(selectedActor.motionPrompt);
      if (selectedActor.duration) setDurationSec(selectedActor.duration);
    }
  }, [selectedActorId]);

  // Master Timeline Animation Loop
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
  }, [isPlaying, maxDuration, playbackSpeed]);

  // Keyboard Shortcuts (Space for Play/Pause, W/E/R for Transforms)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key.toLowerCase() === 'w') {
        setTransformMode('translate');
      } else if (e.key.toLowerCase() === 'e') {
        setTransformMode('rotate');
      } else if (e.key.toLowerCase() === 'r') {
        setTransformMode('scale');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle Actor Transform Updates from 3D Viewport
  const handleUpdateActorTransform = (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => {
    const updated = characters.map((c) => {
      if (c.id === id) {
        // Regenerate trajectory based on new starting position
        const traj = KimodoService.generateTrajectory(
          trajectoryMode,
          c.duration || 4.0,
          position,
          speedMultiplier
        );
        return { ...c, position, rotation, scale, trajectory: traj };
      }
      return c;
    });
    onUpdateProject({ ...currentProject, characters: updated });
  };

  // Generate Motion with Kimodo AI
  const handleGenerateMotion = async () => {
    if (!motionPrompt.trim() || !selectedActor) return;
    setIsGenerating(true);
    setStatusText('Synthesizing motion with NVIDIA Kimodo Stage...');

    try {
      const res = await KimodoService.generateMotion(
        {
          prompt: motionPrompt,
          durationSeconds: durationSec,
          actorId: selectedActor.id,
          trajectoryMode,
          speed: speedMultiplier,
          startPosition: selectedActor.position,
        },
        (s) => setStatusText(s)
      );

      const updated = characters.map((c) => {
        if (c.id === selectedActor.id) {
          return {
            ...c,
            motionPrompt: motionPrompt,
            currentAnimation: res.animationName,
            duration: res.duration,
            trajectory: res.trajectory,
            motionData: res.motionData,
            bvhUrl: res.bvhUrl,
          };
        }
        return c;
      });

      onUpdateProject({ ...currentProject, characters: updated });
      setIsPlaying(true);
      setTimelineSec(0);
      setStatusText(`✓ True Kimodo Neural Motion applied to ${selectedActor.name}`);
      setTimeout(() => setStatusText(null), 4000);
    } catch (e: any) {
      alert(`Kimodo generation failed: ${e.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // Apply Quick Preset Motion
  const handleApplyPreset = async (preset: MotionPreset) => {
    if (!selectedActor) return;
    setMotionPrompt(preset.prompt);
    setDurationSec(preset.defaultDuration);
    setTrajectoryMode(preset.trajectoryMode);

    setIsGenerating(true);
    setStatusText(`Synthesizing real Kimodo neural motion for: "${preset.name}"...`);

    try {
      const res = await KimodoService.generateMotion(
        {
          prompt: preset.prompt,
          durationSeconds: preset.defaultDuration,
          actorId: selectedActor.id,
          trajectoryMode: preset.trajectoryMode,
          speed: speedMultiplier,
          startPosition: selectedActor.position,
        },
        (s) => setStatusText(s)
      );

      const updated = characters.map((c) => {
        if (c.id === selectedActor.id) {
          return {
            ...c,
            motionPrompt: preset.prompt,
            currentAnimation: preset.name,
            duration: res.duration,
            trajectory: res.trajectory,
            motionData: res.motionData,
            bvhUrl: res.bvhUrl,
          };
        }
        return c;
      });

      onUpdateProject({ ...currentProject, characters: updated });
      setIsPlaying(true);
      setTimelineSec(0);
      setStatusText(`✓ True Kimodo Neural Motion "${preset.name}" applied to ${selectedActor.name}`);
      setTimeout(() => setStatusText(null), 3000);
    } catch (e: any) {
      console.warn('Kimodo preset generation note:', e);
      // Even if remote generation encounters an issue, update prompt & duration
      setStatusText(`Prompt set to: ${preset.name}`);
      setTimeout(() => setStatusText(null), 3000);
    } finally {
      setIsGenerating(false);
    }
  };

  // Add New Actor to Scene
  const handleAddActor = (type: 'soma' | 'g1') => {
    const count = characters.length + 1;
    const isSoma = type === 'soma';
    const newActor: CharacterActor = {
      id: `actor_${type}_${Date.now()}`,
      name: isSoma ? `SOMA Character ${count}` : `Unit G1 (${count})`,
      characterType: type,
      avatar: isSoma ? '🏃' : '🤖',
      color: isSoma ? '#00ffcc' : '#ff9500',
      position: [(Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4],
      rotation: [0, (Math.random() - 0.5) * Math.PI, 0],
      scale: [1, 1, 1],
      currentAnimation: 'Walk Forward',
      motionPrompt: 'walks forward steadily with natural arm sway',
      duration: 4.0,
      trajectory: KimodoService.generateTrajectory('straight', 4.0, [0, 0, 0], 1.0),
    };

    const updated = [...characters, newActor];
    onUpdateProject({ ...currentProject, characters: updated });
    setSelectedActorId(newActor.id);
  };

  // Remove Selected Actor
  const handleDeleteActor = (id: string) => {
    if (characters.length <= 1) {
      alert('Must keep at least one character on stage.');
      return;
    }
    const updated = characters.filter((c) => c.id !== id);
    onUpdateProject({ ...currentProject, characters: updated });
    if (selectedActorId === id) {
      setSelectedActorId(updated[0].id);
    }
  };

  const assets = currentProject.scenes || [];

  return (
    <div className="relative w-full h-[calc(100vh-61px)] overflow-hidden bg-background flex flex-col">
      {/* Viewport Area */}
      <div className="flex-1 relative w-full h-full flex">
        {/* Main 3D Three.js Virtual Stage */}
        <div className="flex-1 relative w-full h-full">
          <ThreeStage
            assets={assets}
            selectedAssetId={null}
            characters={characters.map((c) => ({ ...c, renderMode }))}
            selectedActorId={selectedActorId}
            transformMode={transformMode}
            onSelectActor={(id) => setSelectedActorId(id || '')}
            onUpdateActorTransform={handleUpdateActorTransform}
            currentTimelineTime={timelineSec}
            isPlaying={isPlaying}
            showTrajectories={showTrajectories}
            panoramaUrl={currentProject.panoramaUrl}
            panoramaRotation={currentProject.panoramaRotation || 0}
            splatUrl={currentProject.splatUrl}
          />

          {/* Status Toast */}
          {statusText && (
            <div className="absolute top-md left-1/2 -translate-x-1/2 z-40 bg-surface-container/95 border border-primary/40 px-lg py-sm rounded-lg backdrop-blur-xl shadow-2xl flex items-center gap-md animate-fadeIn">
              <span className="material-symbols-outlined text-primary text-[20px]">
                {isGenerating ? 'progress_activity' : 'check_circle'}
              </span>
              <span className="font-label-caps text-xs text-primary tracking-wider uppercase font-medium">
                {statusText}
              </span>
            </div>
          )}

          {/* Top Left Floating Bar: Actor Roster & Transform Controls */}
          <div className="absolute top-md left-md z-30 flex flex-col gap-xs">
            {/* Actor Roster Selector */}
            <div className="bg-surface-container/90 border border-outline-variant/40 p-xs rounded-xl backdrop-blur-xl flex items-center gap-xs shadow-2xl">
              {characters.map((act) => (
                <button
                  key={act.id}
                  onClick={() => setSelectedActorId(act.id)}
                  className={`px-md py-xs rounded-lg text-xs font-label-caps tracking-wider transition-all cursor-pointer flex items-center gap-xs ${
                    selectedActorId === act.id
                      ? 'bg-primary text-background font-medium shadow-md'
                      : 'text-on-surface-variant hover:text-primary hover:bg-surface-variant'
                  }`}
                >
                  <span>{act.avatar || '🏃'}</span>
                  <span>{act.name}</span>
                </button>
              ))}

              {/* Add Actor Button */}
              <div className="flex items-center gap-[2px] ml-xs border-l border-outline-variant/30 pl-xs">
                <button
                  onClick={() => handleAddActor('soma')}
                  title="Add SOMA Character"
                  className="px-sm py-xs text-[11px] font-label-caps text-on-surface-variant hover:text-primary hover:bg-surface-variant rounded flex items-center gap-[2px] cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span>
                  +SOMA
                </button>
                <button
                  onClick={() => handleAddActor('g1')}
                  title="Add Unit G1 Robot"
                  className="px-sm py-xs text-[11px] font-label-caps text-on-surface-variant hover:text-primary hover:bg-surface-variant rounded flex items-center gap-[2px] cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span>
                  +G1
                </button>
              </div>
            </div>

            {/* Transform Mode Selector & Trajectory Toggle */}
            <div className="bg-surface-container/90 border border-outline-variant/40 p-xs rounded-xl backdrop-blur-xl flex items-center gap-xs shadow-xl w-fit">
              <button
                onClick={() => setTransformMode('translate')}
                title="Move (W)"
                className={`p-xs rounded-lg transition-colors cursor-pointer ${
                  transformMode === 'translate' ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">open_with</span>
              </button>
              <button
                onClick={() => setTransformMode('rotate')}
                title="Rotate (E)"
                className={`p-xs rounded-lg transition-colors cursor-pointer ${
                  transformMode === 'rotate' ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">rotate_90_degrees_ccw</span>
              </button>
              <button
                onClick={() => setTransformMode('scale')}
                title="Scale (R)"
                className={`p-xs rounded-lg transition-colors cursor-pointer ${
                  transformMode === 'scale' ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">aspect_ratio</span>
              </button>

              <div className="h-4 w-[1px] bg-outline-variant/40 mx-xs" />

              {/* SOMA Display Mode Switcher (Mesh / Skeleton / Hybrid) */}
              <div className="flex items-center gap-[2px] bg-surface-container-low p-[2px] rounded-lg">
                <button
                  onClick={() => setRenderMode('mesh')}
                  title="SOMA Anatomical Human Body Mesh"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    renderMode === 'mesh' ? 'bg-primary text-background font-semibold' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  MESH
                </button>
                <button
                  onClick={() => setRenderMode('skeleton')}
                  title="SOMA 24-Joint Biomechanical Skeleton Rig"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    renderMode === 'skeleton' ? 'bg-primary text-background font-semibold' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  SKEL
                </button>
                <button
                  onClick={() => setRenderMode('hybrid')}
                  title="SOMA X-Ray Translucent Mesh + Skeleton"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    renderMode === 'hybrid' ? 'bg-primary text-background font-semibold' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  HYBRID
                </button>
              </div>

              <div className="h-4 w-[1px] bg-outline-variant/40 mx-xs" />

              <button
                onClick={() => setShowTrajectories(!showTrajectories)}
                title="Toggle 3D Motion Trajectory Spline"
                className={`px-sm py-xs text-[11px] font-label-caps tracking-wider rounded-lg transition-colors flex items-center gap-xs cursor-pointer ${
                  showTrajectories ? 'bg-surface-container-high text-primary font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">timeline</span>
                PATH
              </button>

              {selectedActor?.motionData && (
                <div className="flex items-center gap-1 bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 px-sm py-[2px] rounded-lg text-[10px] font-label-caps tracking-wider font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  KIMODO DIFFUSION ({selectedActor.motionData.num_frames}F @ {selectedActor.motionData.fps}FPS)
                </div>
              )}

              {characters.length > 1 && (
                <button
                  onClick={() => handleDeleteActor(selectedActorId)}
                  title="Remove Selected Actor"
                  className="p-xs text-error hover:bg-error/10 rounded cursor-pointer ml-xs"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              )}
            </div>
          </div>

          {/* Top Right: Live Kimodo Viser Engine Toggle */}
          <div className="absolute top-md right-md z-30">
            <button
              onClick={() => setShowViserEmbed(!showViserEmbed)}
              className={`px-md py-sm rounded-xl font-label-caps text-xs tracking-wider border backdrop-blur-xl flex items-center gap-xs transition-all shadow-xl cursor-pointer ${
                showViserEmbed
                  ? 'bg-primary text-background border-primary font-medium'
                  : 'bg-surface-container/90 border-outline-variant/40 text-on-surface-variant hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">sports_esports</span>
              {showViserEmbed ? 'HIDE VISER 3D STAGE' : 'LIVE KIMODO VISER'}
            </button>
          </div>
        </div>

        {/* Optional Embedded Live NVIDIA Kimodo Viser 3D Stage Side-by-Side */}
        {showViserEmbed && (
          <div className="w-[45%] h-full border-l border-outline-variant/40 bg-surface-container-lowest relative z-20 flex flex-col">
            <div className="p-xs bg-surface-container flex items-center justify-between border-b border-outline-variant/30">
              <span className="font-label-caps text-xs text-primary font-medium flex items-center gap-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                NVIDIA KIMODO VISER CLOUD ENGINE (:7860)
              </span>
              <button
                onClick={() => setShowViserEmbed(false)}
                className="p-xs text-on-surface-variant hover:text-primary rounded cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            <iframe
              src="https://dariushh-kimodo-virtual-stage.hf.space"
              title="Kimodo Virtual Stage Viser View"
              className="flex-1 w-full h-full border-none"
              allow="accelerometer; camera; gyroscope; microphone"
            />
          </div>
        )}
      </div>

      {/* Bottom Director Choreographer & Timeline Panel */}
      <div className="w-full bg-surface-container border-t border-outline-variant/30 p-md z-30 flex flex-col gap-sm">
        {/* Row 1: Natural Language Prompt Input + Controls */}
        <div className="flex items-center gap-sm max-w-6xl mx-auto w-full">
          <div className="flex-1 bg-surface-container-low border border-outline-variant/40 rounded-xl flex items-center px-md py-xs focus-within:border-primary transition-all shadow-inner">
            <span className="material-symbols-outlined text-[20px] text-primary mr-sm">
              directions_run
            </span>
            <input
              type="text"
              value={motionPrompt}
              onChange={(e) => setMotionPrompt(e.target.value)}
              placeholder="Describe character motion in natural language (e.g. walks 4 steps, stops and waves)..."
              className="w-full bg-transparent border-none text-primary text-sm focus:outline-none placeholder:text-on-surface-variant/40 py-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGenerateMotion();
              }}
            />
          </div>

          {/* Trajectory Pattern Dropdown */}
          <select
            value={trajectoryMode}
            onChange={(e) => setTrajectoryMode(e.target.value as any)}
            className="bg-surface-container-low border border-outline-variant/40 text-primary text-xs font-label-caps rounded-xl px-md py-sm focus:outline-none focus:border-primary cursor-pointer"
          >
            <option value="straight">Straight Path</option>
            <option value="arc">90° Arc Turn</option>
            <option value="circle">360° Circle Patrol</option>
            <option value="inplace">In-Place Motion</option>
          </select>

          {/* Duration Slider */}
          <div className="flex items-center gap-xs bg-surface-container-low border border-outline-variant/40 px-md py-xs rounded-xl">
            <span className="font-label-caps text-[10px] text-on-surface-variant tracking-wider">
              DUR:
            </span>
            <input
              type="range"
              min="2"
              max="12"
              step="0.5"
              value={durationSec}
              onChange={(e) => setDurationSec(parseFloat(e.target.value))}
              className="w-16 accent-primary h-1 cursor-pointer"
            />
            <span className="font-label-caps text-xs text-primary w-6 font-mono">
              {durationSec}s
            </span>
          </div>

          {/* Stride Speed Multiplier */}
          <div className="flex items-center gap-xs bg-surface-container-low border border-outline-variant/40 px-sm py-xs rounded-xl">
            <span className="font-label-caps text-[10px] text-on-surface-variant tracking-wider">
              SPD:
            </span>
            <select
              value={speedMultiplier}
              onChange={(e) => setSpeedMultiplier(parseFloat(e.target.value))}
              className="bg-transparent border-none text-primary text-xs font-mono focus:outline-none cursor-pointer"
            >
              <option value="0.75" className="bg-surface-container">0.75x</option>
              <option value="1.0" className="bg-surface-container">1.0x</option>
              <option value="1.25" className="bg-surface-container">1.25x</option>
              <option value="1.5" className="bg-surface-container">1.5x</option>
            </select>
          </div>

          {/* Kimodo AI Generate Action Button */}
          <button
            onClick={handleGenerateMotion}
            disabled={isGenerating}
            className="bg-primary text-background font-label-caps text-label-caps px-lg py-sm rounded-xl hover:bg-white/90 transition-all font-semibold shrink-0 flex items-center gap-xs cursor-pointer disabled:opacity-50 shadow-lg"
          >
            <span className="material-symbols-outlined text-[18px]">
              {isGenerating ? 'progress_activity' : 'auto_fix_high'}
            </span>
            {isGenerating ? 'KIMODO GENERATING...' : 'GENERATE MOTION'}
          </button>

          {/* BVH Motion Capture Download Button */}
          {selectedActor?.bvhUrl && (
            <a
              href={selectedActor.bvhUrl}
              download={`${selectedActor.name.replace(/\s+/g, '_')}_motion.bvh`}
              title="Download BVH Motion Capture"
              className="bg-surface-container border border-primary/40 hover:bg-primary hover:text-background text-primary px-md py-sm rounded-xl font-label-caps text-xs tracking-wider transition-all flex items-center gap-xs cursor-pointer shadow-md"
            >
              <span className="material-symbols-outlined text-[16px]">download</span>
              BVH EXPORT
            </a>
          )}
        </div>

        {/* Row 2: Inspiration Prompt Pills */}
        <div className="flex items-center gap-xs max-w-6xl mx-auto w-full overflow-x-auto pb-[2px] no-scrollbar">
          <span className="font-label-caps text-[10px] text-on-surface-variant uppercase tracking-wider shrink-0 mr-xs flex items-center gap-[2px]">
            <span className="material-symbols-outlined text-[13px]">lightbulb</span>
            SUGGESTIONS:
          </span>
          {SUGGESTED_PROMPTS.map((p, idx) => (
            <button
              key={idx}
              onClick={() => {
                setMotionPrompt(p);
              }}
              className="shrink-0 bg-surface-container-low border border-outline-variant/30 hover:border-primary/50 text-on-surface-variant hover:text-primary px-sm py-[2px] rounded-lg text-[11px] font-label-caps tracking-wider transition-colors cursor-pointer"
            >
              {p}
            </button>
          ))}
        </div>

        {/* Row 3: Quick Preset Motion Deck */}
        <div className="flex items-center gap-xs max-w-6xl mx-auto w-full overflow-x-auto pb-[2px] no-scrollbar">
          <span className="font-label-caps text-[10px] text-on-surface-variant uppercase tracking-wider shrink-0 mr-xs flex items-center gap-[2px]">
            <span className="material-symbols-outlined text-[13px]">tune</span>
            PRESET DECK:
          </span>
          {MOTION_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => handleApplyPreset(preset)}
              className={`shrink-0 px-sm py-[3px] rounded-lg text-xs font-label-caps tracking-wider transition-all flex items-center gap-xs cursor-pointer border ${
                selectedActor?.currentAnimation === preset.name
                  ? 'bg-primary/10 border-primary text-primary font-medium'
                  : 'bg-surface-container-low border-outline-variant/30 text-on-surface-variant hover:text-primary hover:bg-surface-variant'
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">{preset.icon}</span>
              {preset.name}
            </button>
          ))}
        </div>

        {/* Row 4: Master Timeline Sequencer & Transport Controls */}
        <div className="flex items-center justify-between gap-md max-w-6xl mx-auto w-full pt-xs border-t border-outline-variant/10">
          <div className="flex items-center gap-xs">
            {/* Play / Pause */}
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              className="p-xs text-primary hover:bg-surface-variant rounded-lg transition-colors cursor-pointer flex items-center justify-center"
            >
              <span className="material-symbols-outlined text-[26px]">
                {isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>

            {/* Replay */}
            <button
              onClick={() => setTimelineSec(0)}
              title="Reset to 00:00"
              className="p-xs text-on-surface-variant hover:text-primary rounded-lg transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[20px]">replay</span>
            </button>

            {/* Time Stamp */}
            <span className="font-mono text-xs text-primary tracking-wider ml-xs font-medium">
              00:{timelineSec.toFixed(1).padStart(4, '0')} / 00:{maxDuration.toFixed(1).padStart(4, '0')}
            </span>

            {/* Playback Speed Multiplier */}
            <div className="flex items-center gap-[2px] ml-sm bg-surface-container-low border border-outline-variant/30 rounded p-[2px]">
              {[0.5, 1.0, 1.5, 2.0].map((spd) => (
                <button
                  key={spd}
                  onClick={() => setPlaybackSpeed(spd)}
                  className={`px-xs py-[1px] text-[10px] font-label-caps rounded cursor-pointer ${
                    playbackSpeed === spd ? 'bg-primary text-background font-semibold' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>

          {/* Timeline Range Slider with Keyframe Track */}
          <div className="flex-1 mx-md relative flex items-center">
            <input
              type="range"
              min="0"
              max={maxDuration}
              step="0.05"
              value={timelineSec}
              onChange={(e) => setTimelineSec(parseFloat(e.target.value))}
              className="w-full accent-primary h-2 bg-surface-container-highest rounded-lg cursor-pointer"
            />
          </div>

          {/* Advance to Stage 03: Camera & Record */}
          <div className="flex items-center gap-sm">
            <span className="font-label-caps text-[10px] text-on-surface-variant tracking-widest uppercase">
              KIMODO SOMA V1.0
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
    </div>
  );
};
