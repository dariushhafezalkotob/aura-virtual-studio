import React from 'react';
import { WorkflowStage, Project } from '../../types';

interface TopBarProps {
  currentStage: WorkflowStage;
  currentProject: Project | null;
  onNavigate: (stage: WorkflowStage) => void;
  subtitle?: string;
  /** Signed-in account, shown on the avatar button. */
  userEmail?: string;
  onSignOut?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  currentStage,
  currentProject,
  onNavigate,
  subtitle,
  userEmail,
  onSignOut,
}) => {
  if (currentStage === 'projects') {
    return null;
  }

  return (
    <header className="w-full flex items-center justify-between px-margin-safe py-md z-50 sticky top-0 bg-background/85 backdrop-blur-md border-b border-outline-variant/20">
      {/* Left Back Navigation */}
      <div className="flex-1 flex items-center gap-md">
        {currentStage === 'workflow' ? (
          <button
            onClick={() => onNavigate('projects')}
            className="flex items-center gap-sm text-on-surface-variant hover:text-primary transition-colors duration-300 group cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px] group-hover:-translate-x-1 transition-transform duration-300">
              arrow_back
            </span>
            <span className="font-label-caps text-label-caps tracking-widest opacity-90 group-hover:opacity-100">
              BACK TO PROJECTS
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-md">
            <button
              onClick={() => onNavigate('workflow')}
              className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-surface-variant transition-colors group cursor-pointer"
              title="Back to Workflow"
            >
              <span className="material-symbols-outlined text-on-surface-variant group-hover:text-primary transition-colors text-xl">
                arrow_back
              </span>
            </button>
            <span className="font-label-caps text-label-caps tracking-widest text-primary font-semibold">
              AURA
            </span>
            <span className="text-outline-variant mx-xs">/</span>
            <h1 className="font-headline-sm text-headline-sm text-primary font-bold">
              {subtitle || 'Studio'}
            </h1>
          </div>
        )}
      </div>

      {/* Center Project Title (in workflow screen) */}
      {currentStage === 'workflow' && currentProject && (
        <div className="flex-1 text-center flex flex-col items-center">
          <span className="font-label-caps text-[10px] text-on-surface-variant tracking-[0.2em] mb-0.5">
            CURRENT PROJECT
          </span>
          <h1 className="font-headline-sm text-headline-sm text-primary tracking-widest uppercase font-semibold">
            {currentProject.name}
          </h1>
        </div>
      )}

      {/* Right Action Icons */}
      <div className="flex-1 flex justify-end items-center gap-sm">
        <button
          className="text-on-surface-variant hover:text-primary transition-colors duration-300 cursor-pointer p-sm rounded-full hover:bg-surface-variant flex items-center justify-center"
          title="Studio Settings"
        >
          <span className="material-symbols-outlined text-[20px]">settings</span>
        </button>
        <button
          onClick={onSignOut}
          className="text-on-surface-variant hover:text-primary transition-colors duration-300 cursor-pointer p-sm rounded-full hover:bg-surface-variant flex items-center justify-center gap-xs"
          title={userEmail ? `Signed in as ${userEmail} - click to sign out` : 'Account'}
        >
          <span className="material-symbols-outlined text-[20px]">account_circle</span>
          {userEmail && (
            <span className="hidden lg:inline text-[11px] font-label-caps tracking-wider max-w-[160px] truncate">
              {userEmail}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
