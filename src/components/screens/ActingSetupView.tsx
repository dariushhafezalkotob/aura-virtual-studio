import React, { useState } from 'react';
import { Project, CharacterActor } from '../../types';
import { ThreeStage } from '../viewport/ThreeStage';
import { KimodoService } from '../../services/kimodoService';

interface ActingSetupViewProps {
  currentProject: Project;
  onUpdateProject: (updated: Project) => void;
}

const DEFAULT_ACTORS = [
  { id: 'actor_1', name: 'Lead Actor (Alpha)', type: 'Humanoid', avatar: '🏃' },
  { id: 'actor_2', name: 'Supporting (Beta)', type: 'Humanoid', avatar: '🚶' },
];

export const ActingSetupView: React.FC<ActingSetupViewProps> = ({
  currentProject,
  onUpdateProject,
}) => {
  const [motionPrompt, setMotionPrompt] = useState('walks forward 3 paces, stops and looks around');
  const [selectedActor, setSelectedActor] = useState(DEFAULT_ACTORS[0]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timelineSec, setTimelineSec] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);

  const assets = currentProject.scenes || [];

  const handleGenerateMotion = async () => {
    if (!motionPrompt.trim()) return;
    setIsGenerating(true);
    try {
      const res = await KimodoService.generateMotion(
        {
          prompt: motionPrompt,
          actorId: selectedActor.id,
        },
        (s) => setStatusText(s)
      );

      const character: CharacterActor = {
        id: selectedActor.id,
        name: selectedActor.name,
        modelUrl: '',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        motionPrompt,
        currentAnimation: res.animationName,
      };

      onUpdateProject({
        ...currentProject,
        characters: [character],
      });

      setStatusText(`Applied: "${motionPrompt}" to ${selectedActor.name}`);
      setTimeout(() => setStatusText(null), 4000);
    } catch (e: any) {
      alert(`Motion error: ${e.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="relative w-full h-[calc(100vh-61px)] overflow-hidden bg-background flex flex-col">
      {/* Viewport Area */}
      <div className="flex-1 relative w-full h-full">
        <ThreeStage assets={assets} selectedAssetId={null} />

        {/* Status Toast */}
        {statusText && (
          <div className="absolute top-md left-1/2 -translate-x-1/2 z-40 bg-surface-container/95 border border-outline-variant/60 px-lg py-sm rounded-lg backdrop-blur-xl shadow-2xl flex items-center gap-md">
            <span className="material-symbols-outlined text-primary text-[20px]">
              {isGenerating ? 'progress_activity' : 'check_circle'}
            </span>
            <span className="font-label-caps text-xs text-primary tracking-wider uppercase">
              {statusText}
            </span>
          </div>
        )}

        {/* Actor Selector Floating Pill */}
        <div className="absolute top-md left-md z-30 bg-surface-container/90 border border-outline-variant/40 p-xs rounded-xl backdrop-blur-xl flex items-center gap-xs">
          {DEFAULT_ACTORS.map((act) => (
            <button
              key={act.id}
              onClick={() => setSelectedActor(act)}
              className={`px-md py-xs rounded-lg text-xs font-label-caps tracking-wider transition-colors cursor-pointer flex items-center gap-xs ${
                selectedActor.id === act.id
                  ? 'bg-primary text-background font-medium'
                  : 'text-on-surface-variant hover:text-primary hover:bg-surface-variant'
              }`}
            >
              <span>{act.avatar}</span>
              {act.name}
            </button>
          ))}
        </div>
      </div>

      {/* Bottom Timeline & Motion Choreographer Panel */}
      <div className="w-full bg-surface-container border-t border-outline-variant/30 p-md z-30 flex flex-col gap-sm">
        {/* Prompt Input Row */}
        <div className="flex items-center gap-sm max-w-4xl mx-auto w-full">
          <div className="flex-1 bg-surface-container-low border border-outline-variant/40 rounded-lg flex items-center px-md py-xs focus-within:border-primary transition-colors">
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant mr-xs">
              directions_run
            </span>
            <input
              type="text"
              value={motionPrompt}
              onChange={(e) => setMotionPrompt(e.target.value)}
              placeholder="Describe character motion (e.g. walks 3 steps, turns right and waves)..."
              className="w-full bg-transparent border-none text-primary text-sm focus:outline-none placeholder:text-on-surface-variant/40 py-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGenerateMotion();
              }}
            />
          </div>
          <button
            onClick={handleGenerateMotion}
            disabled={isGenerating}
            className="bg-primary text-background font-label-caps text-label-caps px-lg py-sm rounded-lg hover:bg-white/90 transition-colors font-medium shrink-0 flex items-center gap-xs cursor-pointer disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">animation</span>
            {isGenerating ? 'GENERATING...' : 'APPLY MOTION'}
          </button>
        </div>

        {/* Timeline Sequencer Bar */}
        <div className="flex items-center justify-between gap-md max-w-4xl mx-auto w-full pt-xs border-t border-outline-variant/10">
          <div className="flex items-center gap-xs">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="p-xs text-primary hover:bg-surface-variant rounded cursor-pointer"
            >
              <span className="material-symbols-outlined text-[24px]">
                {isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>
            <button
              onClick={() => setTimelineSec(0)}
              className="p-xs text-on-surface-variant hover:text-primary rounded cursor-pointer"
            >
              <span className="material-symbols-outlined text-[20px]">replay</span>
            </button>
            <span className="font-label-caps text-xs text-primary tracking-wider ml-sm">
              00:{timelineSec.toString().padStart(2, '0')} / 00:10
            </span>
          </div>

          <div className="flex-1 mx-md">
            <input
              type="range"
              min="0"
              max="10"
              step="0.1"
              value={timelineSec}
              onChange={(e) => setTimelineSec(parseFloat(e.target.value))}
              className="w-full accent-primary h-1 bg-surface-container-highest cursor-pointer"
            />
          </div>

          <span className="font-label-caps text-[10px] text-on-surface-variant tracking-widest">
            KIMODO MOTION ENGINE
          </span>
        </div>
      </div>
    </div>
  );
};
