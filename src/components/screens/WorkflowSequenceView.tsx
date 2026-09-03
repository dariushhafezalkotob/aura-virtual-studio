import React from 'react';
import { WorkflowStage, Project } from '../../types';

interface WorkflowSequenceViewProps {
  currentProject: Project;
  onSelectStage: (stage: WorkflowStage) => void;
}

export const WorkflowSequenceView: React.FC<WorkflowSequenceViewProps> = ({
  currentProject,
  onSelectStage,
}) => {
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-margin-safe py-xl z-10 w-full max-w-7xl mx-auto my-auto">
      {/* Hero Intro */}
      <div className="text-center mb-xl w-full max-w-2xl">
        <span className="font-label-caps text-[11px] text-on-surface-variant tracking-[0.25em] uppercase mb-sm block">
          PRODUCTION PIPELINE
        </span>
        <h2 className="font-display-lg text-headline-lg-mobile md:text-[44px] text-primary mb-md font-light leading-tight">
          Workflow Sequence
        </h2>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-lg mx-auto leading-relaxed text-sm opacity-80">
          Follow the production stages below to construct, choreograph, and capture your virtual scene in{' '}
          <span className="text-primary font-medium">{currentProject.name}</span>.
        </p>
      </div>

      {/* Workflow Cards (Bento 3 columns) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter w-full">
        {/* Stage 1: Scene Design */}
        <div
          onClick={() => onSelectStage('stage1_scene')}
          className="group relative flex flex-col h-full bg-surface-container-low border border-surface-container-highest p-xl hover:bg-surface-container hover:border-outline-variant transition-all duration-500 overflow-hidden cursor-pointer min-h-[300px]"
        >
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
          <div className="mb-lg z-10 flex items-center justify-between w-full">
            <span className="font-label-caps text-label-caps text-on-surface-variant tracking-widest">
              STAGE 01
            </span>
            <span className="material-symbols-outlined text-[32px] text-primary/70 group-hover:text-primary transition-colors duration-300">
              view_in_ar
            </span>
          </div>
          <div className="mt-auto z-10 flex flex-col gap-sm">
            <h3 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary group-hover:-translate-y-1 transition-transform duration-300 font-normal">
              Scene Design
            </h3>
            <div className="h-px w-8 bg-on-surface-variant/30 my-2 group-hover:w-full group-hover:bg-primary/50 transition-all duration-500" />
            <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed opacity-80 group-hover:opacity-100 transition-opacity duration-300">
              Set up the environment, characters, objects, and actor positions using AI 3D generation (TRELLIS).
            </p>
            <div className="mt-md flex items-center gap-xs text-primary font-label-caps text-[10px] tracking-widest opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              ENTER STUDIO <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
            </div>
          </div>
        </div>

        {/* Stage 2: Acting Setup */}
        <div
          onClick={() => onSelectStage('stage2_acting')}
          className="group relative flex flex-col h-full bg-surface-container-low border border-surface-container-highest p-xl hover:bg-surface-container hover:border-outline-variant transition-all duration-500 overflow-hidden cursor-pointer min-h-[300px]"
        >
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
          <div className="mb-lg z-10 flex items-center justify-between w-full">
            <span className="font-label-caps text-label-caps text-on-surface-variant tracking-widest">
              STAGE 02
            </span>
            <span className="material-symbols-outlined text-[32px] text-primary/70 group-hover:text-primary transition-colors duration-300">
              recent_actors
            </span>
          </div>
          <div className="mt-auto z-10 flex flex-col gap-sm">
            <h3 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary group-hover:-translate-y-1 transition-transform duration-300 font-normal">
              Acting Setup
            </h3>
            <div className="h-px w-8 bg-on-surface-variant/30 my-2 group-hover:w-full group-hover:bg-primary/50 transition-all duration-500" />
            <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed opacity-80 group-hover:opacity-100 transition-opacity duration-300">
              Select actors, generate their performances via text/waypoint motion (Kimodo), and choreograph timing.
            </p>
            <div className="mt-md flex items-center gap-xs text-primary font-label-caps text-[10px] tracking-widest opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              OPEN CHOREOGRAPHER <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
            </div>
          </div>
        </div>

        {/* Stage 3: Camera Record */}
        <div
          onClick={() => onSelectStage('stage3_camera')}
          className="group relative flex flex-col h-full bg-surface-container-low border border-surface-container-highest p-xl hover:bg-surface-container hover:border-outline-variant transition-all duration-500 overflow-hidden cursor-pointer min-h-[300px]"
        >
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
          <div className="mb-lg z-10 flex items-center justify-between w-full">
            <span className="font-label-caps text-label-caps text-on-surface-variant tracking-widest">
              STAGE 03
            </span>
            <span className="material-symbols-outlined text-[32px] text-primary/70 group-hover:text-primary transition-colors duration-300">
              videocam
            </span>
          </div>
          <div className="mt-auto z-10 flex flex-col gap-sm">
            <h3 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary group-hover:-translate-y-1 transition-transform duration-300 font-normal">
              Camera Record
            </h3>
            <div className="h-px w-8 bg-on-surface-variant/30 my-2 group-hover:w-full group-hover:bg-primary/50 transition-all duration-500" />
            <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed opacity-80 group-hover:opacity-100 transition-opacity duration-300">
              Play the finished performance and film it using mobile/tablet tracking or cinematic virtual camera.
            </p>
            <div className="mt-md flex items-center gap-xs text-primary font-label-caps text-[10px] tracking-widest opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              LAUNCH VIEWFINDER <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};
